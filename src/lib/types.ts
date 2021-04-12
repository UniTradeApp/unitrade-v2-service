import { UniTradeProvider, UniSwapProvider, AccountProvider, EthGasStationProvider } from "../providers";

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
