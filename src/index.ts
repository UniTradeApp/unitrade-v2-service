#!/usr/bin/env node

/**
 * UniTrade Order Execution Service
 *
 * "The Executor"
 */
import debug from "debug";
import { EventEmitter } from "events";
import Web3 from "web3";

import { config } from "./config";
import { loader } from "./utils/loader";
import { TokenPool } from "./lib/classes";
import { IContractEvent, ExitCodes, IDependencies, IUniTradeOrder, OrderState } from "./lib/types";
import { toBN } from "web3-utils";
const log = debug("unitrade-service");

export class UniTradeExecutorService {
  private dependencies: IDependencies;
  private activeOrders: IUniTradeOrder[];
  private orderLocks: { [key: string]: boolean } = {};
  private badOrderMap: { [key: string]: number } = {};
  private pools: { [pairAddress: string]: TokenPool } = {};
  private poolListeners: { [pairAddress: string]: EventEmitter } = {};
  private orderListeners: { [eventName: string]: EventEmitter } = {};
  private failureListener: EventEmitter;
  private failedTxnTimer: any = null;
  private failedTxnCount: number = 0;
  private failedTxnGasCost: number = 0;

  /**
   * Log an error and/or shutdown the service
   */
  private handleError(error: Error, exitCode = ExitCodes.GenericError) {
    log(error);
    if (exitCode) {
      this.handleShutdown(exitCode);
    }
  }

  /**
   * Gracefully handle app shutdown
   * @param exitCode
   */
  private async handleShutdown(exitCode = ExitCodes.Success) {
    try {
      log("Shutting down...");

      const poolsKeys = Object.keys(this.poolListeners);
      if (poolsKeys.length) {
        for (let p = 0; p < poolsKeys.length; p += 1) {
          const pairAddress = poolsKeys[p];
          this.poolListeners[pairAddress].removeAllListeners();
          delete this.poolListeners[pairAddress];
        }
      }

      const ordersKeys = Object.keys(this.orderListeners);
      if (ordersKeys.length) {
        for (let p = 0; p < ordersKeys.length; p += 1) {
          const pairAddress = ordersKeys[p];
          this.orderListeners[pairAddress].removeAllListeners();
          delete this.orderListeners[pairAddress];
        }
      }

      if (this.failureListener) this.failureListener.removeAllListeners();

      if (exitCode > ExitCodes.GenericError && config.failureShutdownWebhookUrl) {
        log("Sending shutdown notification to URL: %s", config.failureShutdownWebhookUrl);

        await fetch(config.failureShutdownWebhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: `Executor service has shut down with exit code ${exitCode}`,
          }),
        });
      }

      process.exit(exitCode);
    } catch (err) {
      log("Error during shutdown: %O", err);
      process.exit(1);
    }
  }

  constructor() {
    try {
      this.start();
    } catch (err) {
      log("Error: %O", err);
      this.handleShutdown(ExitCodes.GenericError);
    }
    process.on("SIGINT", () => {
      this.handleShutdown();
    });
    process.on("SIGTERM", () => {
      this.handleShutdown();
    });
  }

  /**
   * Lock an order so it's not run twice
   * @param orderId
   */
  private lockOrder = (orderId: number) => (this.orderLocks[orderId] = true);

  /**
   * Unlock an order for executing
   * @param orderId
   */
  private unlockOrder = (orderId: number) => {
    if (this.orderLocks[orderId]) delete this.orderLocks[orderId];
  };

  /**
   * Get or Create TokenPool
   * @param pairAddress
   */
  private getOrCreatePool = (pairAddress: string) => {
    if (!this.pools[pairAddress]) {
      this.pools[pairAddress] = new TokenPool(pairAddress);
      this.createPoolChangeListener(pairAddress);
    }
    return this.pools[pairAddress];
  };

  /**
   * Add order to associated TokenPool
   * @param orderId
   * @param order
   */
  private addPoolOrder = async (orderId: number, order: IUniTradeOrder) => {
    try {
      const pairAddress = await this.dependencies.providers.uniSwap?.getPairAddress(order.tokenIn, order.tokenOut);
      const pool = this.getOrCreatePool(pairAddress);
      pool.addOrder(orderId, order);
    } catch (err) {
      this.handleError(err, ExitCodes.GenericError);
    }
  };

  /**
   * Remove order from associated TokenPool
   * @param orderId
   * @param order
   */
  private removePoolOrder = async (orderId: number, order: IUniTradeOrder) => {
    try {
      const pairAddress = await this.dependencies.providers.uniSwap?.getPairAddress(order.tokenIn, order.tokenOut);

      const orderPool = this.pools[pairAddress];

      if (orderPool) {
        orderPool.removeOrder(orderId);
      }
    } catch (err) {
      this.handleError(err, ExitCodes.GenericError);
    }
  };

  private executeIfAppropriate = async (order: IUniTradeOrder) => {
    if (this.orderLocks[order.orderId]) return false;

    log(`Checking if order ${order.orderId} is executable...`);

    // Avoid to try to execute an Executed/Cancelled order
    const isActive = order.orderState == OrderState.Placed;
    if (!isActive) {
      log(`Order ${order.orderId} isn't active (current state is ${order.orderState}), ignoring it.`);
      return false;
    }

    // lock the order so it doesn't get processed multiple times
    this.lockOrder(order.orderId);

    const inTheMoney = await this.dependencies.providers.uniSwap?.isInTheMoney(order);
    if (inTheMoney) {
      let estimatedGas;
      try {
        // override the estimated gas for debugging purposes
        estimatedGas = process.env.ESTIMATED_GAS_OVERRIDE
          ? parseInt(process.env.ESTIMATED_GAS_OVERRIDE, 10)
          : await this.dependencies.providers.ethGasStation?.getEstimatedGasForOrder(order.orderId);
        log("Got estimated gas for order %s: %s", order.orderId, estimatedGas);
      } catch (err) {
        log(`Failed order: ${JSON.stringify(order)}`);
        if (this.badOrderMap[order.orderId]) {
          this.badOrderMap[order.orderId] += 1;
        } else {
          this.badOrderMap[order.orderId] = 1;
        }
        if (this.badOrderMap[order.orderId] > Number(config.badOrderRetry)) {
          log("Exceeded number of retries for order %s.  Removing from tracking.", order.orderId);
          this.removePoolOrder(order.orderId, order);
        }
      }
      if (!estimatedGas) {
        log("Cannot retrieve preferred estimated gas for order %s", order.orderId);
        this.unlockOrder(order.orderId);
        return false;
      }
      const gasPrice = this.dependencies.providers.ethGasStation?.getPreferredGasPrice();
      if (!gasPrice) {
        log("Cannot retrieve preferred gas price for order %s", order.orderId);
        this.unlockOrder(order.orderId);
        return false;
      }

      const gas = toBN(estimatedGas).mul(toBN(gasPrice));

      if (gas.lt(toBN(order.executorFee))) {
        try {
          return await this.dependencies.providers.uniTrade?.executeOrder(order, estimatedGas, gasPrice);
        } catch (err) {
          this.handleFailedExecution(err.receipt);
          this.unlockOrder(order.orderId);
          return false;
        }
      } else {
        log(
          "Executor fee for order %s is not high enough to cover the estimated gas cost of executing order (%s < %s)",
          order.orderId,
          order.executorFee,
          gas
        );
      }
    }
    log(`Order ${order.orderId} isn't "In the money" ignoring it...`);
    this.unlockOrder(order.orderId);
    return false;
  };

  /**
   * Handle failures and shut down if necessary
   * @param receipt
   * @returns
   */
  private handleFailedExecution = (receipt: any) => {
    if (!receipt) return;

    this.failedTxnCount += 1;
    this.failedTxnGasCost += receipt.gasUsed || 0;

    log(
      "Transaction %s failed!\n\nFailed txns: %s/%s\nFailed txn gas cost: %s/%s\n\n",
      receipt.transactionHash,
      this.failedTxnCount,
      config.maxFailureCount,
      this.failedTxnGasCost,
      config.maxFailureGasCost
    );

    if (config.maxFailureCount && this.failedTxnCount >= parseInt(config.maxFailureCount)) {
      this.handleError(
        new Error("Number of failed transactions is over the limit - service is shutting down"),
        ExitCodes.TooManyFailures
      );
    }
    if (config.maxFailureGasCost && this.failedTxnGasCost >= parseInt(config.maxFailureGasCost)) {
      this.handleError(
        new Error("Gas cost of failed transactions is over the limit - service is shutting down"),
        ExitCodes.TooMuchGasLost
      );
    }

    // set the timer
    if (config.maxFailureDuration) {
      if (!this.failedTxnTimer || config.resetTimerOnFailure?.toLowerCase() === "true") {
        log("Setting failed transaction timer with duration %s ms", config.maxFailureDuration);
        this.failedTxnTimer = setTimeout(() => {
          log("Failed transactions timer expired - resetting failed transaction count");
          this.failedTxnCount = 0;
          this.failedTxnGasCost = 0;
          this.failedTxnTimer = null;
        }, parseInt(config.maxFailureDuration));
      }
    }
  };

  /**
   * Create listener for UniSwap pool updates
   * @param pairAddress
   */
  private createPoolChangeListener = async (pairAddress: string) => {
    try {
      const pairContract = await this.dependencies.providers.uniSwap?.getOrCreatePairContract(pairAddress);

      this.poolListeners[pairAddress] = await pairContract.events.Sync();
      this.poolListeners[pairAddress].on("data", async () => {
        log("Got UniSwap Sync event for pairAddress %s", pairAddress);
        // remove the subscription if no more orders
        if (!this.pools[pairAddress] || !this.pools[pairAddress].getOrderCount()) {
          this.poolListeners[pairAddress].removeAllListeners();
          delete this.poolListeners[pairAddress];
          delete this.pools[pairAddress];
        } else {
          const ordersKeys = Object.keys(this.pools[pairAddress].orders);
          if (ordersKeys.length) {
            for (let o = 0; o < ordersKeys.length; o += 1) {
              const order = this.pools[pairAddress].orders[ordersKeys[o]];
              if (order) {
                const executed = await this.executeIfAppropriate(order);
                // remove the order
                if (executed && this.pools[pairAddress]) {
                  log("Removing %s from tracking", order.orderId);
                  this.pools[pairAddress].removeOrder(order.orderId);
                }
              }
            }
          }
        }
      });
      this.poolListeners[pairAddress].on("connected", () => {
        log("Listener connected to UniSwap Sync events for pairAddress %s", pairAddress);
      });
      this.poolListeners[pairAddress].on("error", (err) => {
        this.handleError(err, ExitCodes.GenericError);
      });
      this.poolListeners[pairAddress].on("end", async () => {
        log("Listener lost connection to UniSwap Sync events for pairAddress %s! Reconnecting...", pairAddress);
        this.createPoolChangeListener(pairAddress);
      });
    } catch (err) {
      this.handleError(err, ExitCodes.GenericError);
    }
  };

  /**
   * Create listener for UniTrade OrderPlaced events
   */
  private createOrderPlacedListener = async () => {
    try {
      const uniTradeEvents = this.dependencies.providers.uniTrade?.contract.events;

      if (this.orderListeners.OrderPlaced) {
        this.orderListeners.OrderPlaced.removeAllListeners();
        delete this.orderListeners.OrderPlaced;
      }

      this.orderListeners.OrderPlaced = await uniTradeEvents.OrderPlaced();
      this.orderListeners.OrderPlaced.on("data", async (event: any) => {
        if (event.returnValues) {
          log("Received UniTrade OrderPlaced event for orderId: %s", event.returnValues.orderId);
          const order = event.returnValues as IUniTradeOrder;
          const executed = await this.executeIfAppropriate(order);
          if (!executed) {
            log("Adding %s to tracking", order.orderId);
            this.addPoolOrder(order.orderId, order);
          }
        }
      });
      this.orderListeners.OrderPlaced.on("connected", () => {
        log("Listener connected to UniTrade OrderPlaced events");
      });
      this.orderListeners.OrderPlaced.on("error", (err) => {
        this.handleError(err, ExitCodes.GenericError);
      });
      this.orderListeners.OrderPlaced.on("end", async () => {
        log("Listener disconnected from UniTrade OrderPlaced events!");
        this.createOrderPlacedListener();
      });
    } catch (err) {
      this.handleError(err, ExitCodes.GenericError);
    }
  };

  /**
   * Create listener for UniTrade OrderCancelled events
   */
  private createOrderCancelledListener = async () => {
    try {
      const uniTradeEvents = this.dependencies.providers.uniTrade?.contract.events;

      if (this.orderListeners.OrderCancelled) {
        this.orderListeners.OrderCancelled.removeAllListeners();
        delete this.orderListeners.OrderCancelled;
      }

      this.orderListeners.OrderCancelled = await uniTradeEvents.OrderCancelled((err: Error) => {
        if (err) {
          this.handleError(err, ExitCodes.GenericError);
          return;
        }
      });
      this.orderListeners.OrderCancelled.on("data", async (event: any) => {
        if (event.returnValues) {
          log("Received UniTrade OrderCancelled event for orderId: %s", event.returnValues.orderId);
          const order = event.returnValues as IUniTradeOrder;
          this.removePoolOrder(order.orderId, order);
          log("removed pool order for orderId %s", event.returnValues.orderId);

          // remove the subscription if no more orders
          const pairAddress = await this.dependencies.providers.uniSwap?.getPairAddress(order.tokenIn, order.tokenOut);
          log("pair address: ", pairAddress);
          if (!this.pools[pairAddress] || this.pools[pairAddress].getOrderCount()) {
            if (this.poolListeners[pairAddress]) {
              this.poolListeners[pairAddress].removeAllListeners();
              delete this.poolListeners[pairAddress];
            }
            delete this.pools[pairAddress];
          }
        }
      });
      this.orderListeners.OrderCancelled.on("connected", () => {
        log("Listener connected to UniTrade OrderCancelled events");
      });
      this.orderListeners.OrderCancelled.on("error", (err) => {
        this.handleError(err, ExitCodes.GenericError);
      });
      this.orderListeners.OrderCancelled.on("end", async () => {
        log("Listener disconnected from UniTrade OrderCancelled events!");
        this.createOrderCancelledListener();
      });
    } catch (err) {
      this.handleError(err, ExitCodes.GenericError);
    }
  };

  /**
   * Create listener for UniTrade OrderExecuted events
   */
  private createOrderExecutedListener = async () => {
    try {
      const uniTradeEvents = this.dependencies.providers.uniTrade?.contract.events;

      if (this.orderListeners.OrderExecuted) {
        this.orderListeners.OrderExecuted.removeAllListeners();
        delete this.orderListeners.OrderExecuted;
      }

      this.orderListeners.OrderExecuted = await uniTradeEvents.OrderExecuted((err: Error) => {
        if (err) {
          this.handleError(err, ExitCodes.GenericError);
          return;
        }
      });
      this.orderListeners.OrderExecuted.on("data", async (event: IContractEvent) => {
        // did the execution attempt fail?
        const receipt = await this.dependencies.providers.uniTrade?.web3.eth.getTransactionReceipt(
          event.transactionHash
        );

        log("Got receipt for event %O: %O", event, receipt);

        // if (receipt === null) {
        //   this.pendingExecutions.push(event.transactionHash);
        //   if (!this.pendingExecutionChecker) {
        //     this.checkPendingExecutions();
        //     this.pendingExecutionChecker = setInterval(() => {
        //       this.checkPendingExecutions();
        //     }, this.pendingExecutionInterval);
        //   }
        // }

        if (receipt && !receipt.status) {
          this.handleFailedExecution(event.transactionHash);
        } else if (event.returnValues) {
          log("Received UniTrade OrderExecuted event for orderId: %s", event.returnValues.orderId);
          const order = event.returnValues as IUniTradeOrder;
          this.removePoolOrder(order.orderId, order);
          log("removed pool order for orderId %s", event.returnValues.orderId);

          // remove the subscription if no more orders
          const pairAddress = await this.dependencies.providers.uniSwap?.getPairAddress(order.tokenIn, order.tokenOut);
          if (!this.pools[pairAddress] || this.pools[pairAddress].getOrderCount()) {
            if (this.poolListeners[pairAddress]) {
              this.poolListeners[pairAddress].removeAllListeners();
              delete this.poolListeners[pairAddress];
            }
            delete this.pools[pairAddress];
          }
        }
      });
      this.orderListeners.OrderExecuted.on("connected", () => {
        log("Listener connected to UniTrade OrderExecuted events");
      });
      this.orderListeners.OrderExecuted.on("error", (err) => {
        this.handleError(err, ExitCodes.GenericError);
      });
      this.orderListeners.OrderExecuted.on("end", async () => {
        log("Listener disconnected from UniTrade OrderExecuted events!");
        this.createOrderExecutedListener();
      });
    } catch (err) {
      this.handleError(err, ExitCodes.GenericError);
    }
  };

  /**
   * Main function
   */
  private async start() {
    try {
      log("Starting UniTrade executor service...");

      const web3 = new Web3(config.provider.uri);

      this.dependencies = loader(web3);

      if (!this.dependencies.providers.uniSwap) throw new Error("UniSwap Provider not loaded! Shutting down...");
      else if (!this.dependencies.providers.uniTrade) throw new Error("UniTrade Provider not loaded! Shutting down...");
      else if (!this.dependencies.providers.account) throw new Error("Account Provider not loaded! Shutting down...");
      else if (!this.dependencies.providers.ethGasStation)
        throw new Error("EthGasStation Provider not loaded! Shutting down...");

      this.activeOrders = (await this.dependencies.providers.uniTrade?.listOrders()) || [];

      log("Got %s active orders", this.activeOrders.length);

      // Get a list of unique token sets from the open orders
      if (this.activeOrders.length) {
        log("Initializing TokenPools...");
        for (let i = 0; i < this.activeOrders.length; i += 1) {
          const order = this.activeOrders[i];
          await this.addPoolOrder(order.orderId, order);
        }
      }

      // Subscribe to UniTrade events to keep active orders up-to-date
      await this.createOrderPlacedListener();
      await this.createOrderCancelledListener();
      await this.createOrderExecutedListener();
      // await this.createFailedTxnListener();

      log("UniTrade executor service is now running!");
    } catch (err) {
      this.handleError(err, ExitCodes.GenericError);
    }
  }
}

const app = new UniTradeExecutorService();
