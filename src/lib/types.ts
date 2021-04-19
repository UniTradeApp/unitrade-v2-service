import { UniTradeProvider, UniSwapProvider, AccountProvider, EthGasStationProvider } from "../providers";

export enum ExitCodes {
  Success = 0,
  GenericError = 1,
  TooManyFailures = 2,
  TooMuchGasLost = 3,
}

/**
 * Dependencies
 */
export class IDependencies {
  providers: {
    account?: AccountProvider;
    uniTrade?: UniTradeProvider;
    uniSwap?: UniSwapProvider;
    ethGasStation?: EthGasStationProvider;
  };
}

/**
 * Contract Events
 */
export interface IContractEvent {
  event: string;
  signature: string | null;
  address: string;
  returnValues?: { [key: string]: any };
  logIndex: number;
  transactionIndex: number;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  raw: {
    data: string;
    topics: string[];
  };
}

/**
 * Orders
 */
export interface IUniSwapOrder {
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  blockNumber: number;
  from: string;
  to: string;
  gasUsed: number;
  cumulativeGasUsed: number;
  contractAddress: string | null;
  status: boolean;
  logsBloom: string;
  events: any;
}

export interface IUniTradeOrder {
  orderId: number;
  orderType: number;
  maker: string;
  tokenIn: string;
  tokenOut: string;
  amountInOffered: number;
  amountOutExpected: number;
  executorFee: number;
  totalEthDeposited: number;
  orderState: number;
  deflationary: boolean;
}

export enum OrderState {
  Placed = 0,
  Cancelled = 1,
  Executed = 2,
}
