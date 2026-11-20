import { saleStatusAt, type SaleWindow } from '@flash-sale/core';

/**
 * Phase 0 placeholder. The real server — routes, early rejection, publisher
 * confirms, Socket.IO — lands in phases 2-4 of docs/PLAN.md.
 */
export function describeSale(window: SaleWindow, now = new Date()): string {
  return `sale is ${saleStatusAt(window, now)}`;
}
