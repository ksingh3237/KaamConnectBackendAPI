import type { OfferStatus } from '../../generated/prisma/enums.js';

/** A worker's own quote, as they see it. */
export interface OfferSummary {
  id: string;
  visitFee: number;
  etaMinutes: number;
  message: string | null;
  status: OfferStatus;
  createdAt: string;
}

export function toOfferSummary(offer: {
  id: string;
  visitFee: number;
  etaMinutes: number;
  message: string | null;
  status: OfferStatus;
  createdAt: Date;
}): OfferSummary {
  return {
    id: offer.id,
    visitFee: offer.visitFee,
    etaMinutes: offer.etaMinutes,
    message: offer.message,
    status: offer.status,
    createdAt: offer.createdAt.toISOString(),
  };
}
