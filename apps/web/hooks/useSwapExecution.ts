'use client';

import { useEffect, useRef, useState } from 'react';
import { buildSwapTx, buildExactOutputSwapTx, toRawAmount, toStellarAddress } from '@swyft/sdk';
import type { SwapQuote, ExactOutputQuote } from '@swyft/sdk';
import type { Token } from '@swyft/ui';
import { ROUTER_ADDRESS } from '@/lib/constants';
import { useNetworkContext } from '@/context/NetworkContext';
import { useWalletContext } from '@/context/WalletContext';
import { useTransactionStatus } from '@/context/TransactionStatusContext';
import { getAuthToken } from '@/lib/auth';
import { submitTransaction, MevSubmissionError } from '@/lib/mev-submission';
import { useMevProtection } from './useMevProtection';

export type SwapStatus = 'idle' | 'signing' | 'submitting' | 'pending' | 'success' | 'error';
export type SwapError = 'rejected' | 'slippage' | 'network' | 'failed' | null;

interface SwapResult {
  status: SwapStatus;
  error: SwapError;
  txHash: string | null;
  /** Raw Horizon/RPC error detail, when the backend provided one. */
  detail: string | null;
}

interface ExecuteParams {
  poolId: string;
  tokenIn: Token;
  tokenOut: Token;
  amountIn: string;
  quote: SwapQuote;
  walletAddress: string;
}

interface ExecuteExactOutputParams {
  /** Pool fee tier to route through (see {@link ExactOutputQuote}). */
  fee: number;
  tokenIn: Token;
  tokenOut: Token;
  /** Exact amount of `tokenOut` desired. */
  amountOut: string;
  quote: ExactOutputQuote;
  walletAddress: string;
}

const ERROR_MESSAGES: Record<Exclude<SwapError, null>, string> = {
  rejected: 'Swap rejected in wallet',
  slippage: 'Price moved beyond slippage tolerance',
  network: 'Network error — swap could not be submitted',
  failed: 'Transaction failed on-ledger',
};

export function useSwapExecution() {
  const { apiBase, network } = useNetworkContext();
  const { pendingTx, reportTx } = useTransactionStatus();
  const mevProtection = useMevProtection();
  const { enabled: mevEnabled, mevRpcUrl } = mevProtection;
  // Route all signing through the wallet context so xBull and Freighter both work.
  const { signTransaction } = useWalletContext();
  const labelRef = useRef('Swap');
  const transactionNetworkRef = useRef(network);
  const confirmationRpcUrlRef = useRef(mevProtection.rpcUrl);
  const [result, setResult] = useState<SwapResult>({
    status: 'idle',
    error: null,
    txHash: null,
    detail: null,
  });

  // Mirror local swap status into the app-wide indicator so it stays
  // visible even after the confirmation modal closes. 'idle' also covers
  // a silent wallet-rejection, which must clear a stuck "signing" pill.
  useEffect(() => {
    if (result.status === 'idle') {
      reportTx(null);
      return;
    }
    if (result.status === 'success' || result.status === 'error') {
      reportTx({
        label: labelRef.current,
        status: result.status,
        txHash: result.txHash,
        errorMessage: result.detail ?? (result.error ? ERROR_MESSAGES[result.error] : undefined),
        network: transactionNetworkRef.current,
      });
      return;
    }
    reportTx({
      label: labelRef.current,
      status: result.status,
      txHash: result.status === 'pending' ? result.txHash : null,
      rpcUrl: result.status === 'pending' ? confirmationRpcUrlRef.current : undefined,
      network: transactionNetworkRef.current,
    });
  }, [result.status, result.txHash, result.error, result.detail, reportTx]);

  useEffect(() => {
    if (
      result.status !== 'pending' ||
      !result.txHash ||
      pendingTx?.txHash !== result.txHash
    ) {
      return;
    }

    if (pendingTx.status === 'success') {
      setResult((current) =>
        current.txHash === result.txHash
          ? { ...current, status: 'success', error: null, detail: null }
          : current,
      );
    } else if (pendingTx.status === 'error') {
      setResult((current) =>
        current.txHash === result.txHash
          ? {
              ...current,
              status: 'error',
              error: pendingTx.errorCode === 'TX_FAILED' ? 'failed' : 'network',
              detail: pendingTx.errorMessage ?? 'Transaction confirmation failed',
            }
          : current,
      );
    }
  }, [pendingTx, result.status, result.txHash]);

  function reset() {
    setResult({ status: 'idle', error: null, txHash: null, detail: null });
  }

  async function execute(params: ExecuteParams) {
    const { poolId, tokenIn, tokenOut, amountIn, quote, walletAddress } = params;

    if (!signTransaction) {
      setResult({ status: 'error', error: 'network', txHash: null, detail: 'Wallet not connected' });
      return;
    }

    labelRef.current = `${tokenIn.symbol} → ${tokenOut.symbol} swap`;
    transactionNetworkRef.current = network;
    confirmationRpcUrlRef.current = mevProtection.rpcUrl;
    setResult({ status: 'signing', error: null, txHash: null, detail: null });

    try {
      const { xdr } = buildSwapTx({
        poolId: toStellarAddress(poolId),
        tokenInId: toStellarAddress(tokenIn.id),
        tokenOutId: toStellarAddress(tokenOut.id),
        amountIn: toRawAmount(amountIn),
        minimumReceived: toRawAmount(quote.minimumReceived),
        ownerAddress: toStellarAddress(walletAddress),
      });

      // Use wallet-context signTransaction so both Freighter and xBull work.
      // The network passphrase is passed for wallets that need it (Freighter);
      // xBull reads it from the XDR envelope directly.
      const signedXdr = await signTransaction(xdr).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('reject') || msg.includes('cancel') || msg.includes('denied')) {
          return null; // user rejected — handled below
        }
        throw err;
      });

      if (!signedXdr) {
        setResult({ status: 'idle', error: null, txHash: null, detail: null });
        return;
      }

      setResult({ status: 'submitting', error: null, txHash: null, detail: null });

      try {
        const { hash, confirmation } = await submitTransaction({
          signedXdr,
          apiBase,
          authToken: getAuthToken(),
          mevEnabled,
          mevRpcUrl,
          onPending: (pendingHash) =>
            setResult({ status: 'pending', error: null, txHash: pendingHash, detail: null }),
        });
        setResult({
          status: confirmation === 'confirmed' ? 'success' : 'pending',
          error: null,
          txHash: hash,
          detail: null,
        });
      } catch (submitErr) {
        const error: SwapError =
          submitErr instanceof MevSubmissionError
            ? submitErr.code === 'SLIPPAGE_EXCEEDED'
              ? 'slippage'
              : submitErr.code === 'TX_FAILED' || submitErr.code === 'TX_REJECTED'
                ? 'failed'
                : 'network'
            : 'network';
        const detail =
          submitErr instanceof MevSubmissionError
            ? submitErr.detail
              ? `${submitErr.message} (${submitErr.detail})`
              : submitErr.message
            : submitErr instanceof Error
              ? submitErr.message
              : null;
        setResult({ status: 'error', error, txHash: null, detail });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('reject') || msg.includes('cancel') || msg.includes('denied')) {
        setResult({ status: 'idle', error: null, txHash: null, detail: null });
        return;
      }
      setResult({ status: 'error', error: 'network', txHash: null, detail: msg || null });
    }
  }

  async function executeExactOutput(params: ExecuteExactOutputParams) {
    const { fee, tokenIn, tokenOut, amountOut, quote, walletAddress } = params;

    if (!signTransaction) {
      setResult({ status: 'error', error: 'network', txHash: null, detail: 'Wallet not connected' });
      return;
    }

    if (!ROUTER_ADDRESS) {
      setResult({
        status: 'error',
        error: 'network',
        txHash: null,
        detail: 'Exact-output swaps are unavailable: router address is not configured',
      });
      return;
    }

    labelRef.current = `${tokenIn.symbol} → ${tokenOut.symbol} swap`;
    transactionNetworkRef.current = network;
    confirmationRpcUrlRef.current = mevProtection.rpcUrl;
    setResult({ status: 'signing', error: null, txHash: null, detail: null });

    try {
      const { xdr } = buildExactOutputSwapTx({
        routerId: toStellarAddress(ROUTER_ADDRESS),
        tokenInId: toStellarAddress(tokenIn.id),
        tokenOutId: toStellarAddress(tokenOut.id),
        fee,
        amountOut: toRawAmount(amountOut),
        amountInMax: toRawAmount(quote.maximumIn),
        ownerAddress: toStellarAddress(walletAddress),
      });

      const signedXdr = await signTransaction(xdr).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('reject') || msg.includes('cancel') || msg.includes('denied')) {
          return null;
        }
        throw err;
      });

      if (!signedXdr) {
        setResult({ status: 'idle', error: null, txHash: null, detail: null });
        return;
      }

      setResult({ status: 'submitting', error: null, txHash: null, detail: null });

      try {
        const { hash, confirmation } = await submitTransaction({
          signedXdr,
          apiBase,
          authToken: getAuthToken(),
          mevEnabled,
          mevRpcUrl,
          onPending: (pendingHash) =>
            setResult({ status: 'pending', error: null, txHash: pendingHash, detail: null }),
        });
        setResult({
          status: confirmation === 'confirmed' ? 'success' : 'pending',
          error: null,
          txHash: hash,
          detail: null,
        });
      } catch (submitErr) {
        const error: SwapError =
          submitErr instanceof MevSubmissionError
            ? submitErr.code === 'SLIPPAGE_EXCEEDED'
              ? 'slippage'
              : submitErr.code === 'TX_FAILED' || submitErr.code === 'TX_REJECTED'
                ? 'failed'
                : 'network'
            : 'network';
        const detail =
          submitErr instanceof MevSubmissionError
            ? submitErr.detail
              ? `${submitErr.message} (${submitErr.detail})`
              : submitErr.message
            : submitErr instanceof Error
              ? submitErr.message
              : null;
        setResult({ status: 'error', error, txHash: null, detail });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('reject') || msg.includes('cancel') || msg.includes('denied')) {
        setResult({ status: 'idle', error: null, txHash: null, detail: null });
        return;
      }
      setResult({ status: 'error', error: 'network', txHash: null, detail: msg || null });
    }
  }

  return { ...result, execute, executeExactOutput, reset };
}
