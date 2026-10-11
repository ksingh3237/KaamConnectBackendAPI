import type { JobStatus, JobTiming } from '../../generated/prisma/enums.js';

/** Server-to-app event names (docs/03-api-spec.md section 6). */
export const RealtimeEvent = {
  LEAD_NEW: 'lead.new',
  LEAD_CLOSED: 'lead.closed',
  DIRECT_REQUEST: 'direct.request',
  DIRECT_DECLINED: 'direct.declined',
  DIRECT_EXPIRED: 'direct.expired',
  OFFER_NEW: 'offer.new',
  OFFER_UPDATED: 'offer.updated',
  OFFER_ACCEPTED: 'offer.accepted',
  OFFER_REJECTED: 'offer.rejected',
  JOB_STATUS: 'job.status',
  BOOKING_CONFIRMED: 'booking.confirmed',
  LOCATION_REFRESH: 'location.refresh',
  JOB_LOCATION: 'job.location',
  BILL_UPDATED: 'bill.updated',
  JOB_REOPENED: 'job.reopened',
  ARRIVAL_CODE_RESET: 'job.arrival_code_reset',
  SOS_ACKNOWLEDGED: 'sos.acknowledged',
  SOS_RESOLVED: 'sos.resolved',
} as const;

/** Shared by lead.new and direct.request. Deliberately contains no address, phone or exact location. */
export interface LeadPayload {
  id: string;
  title: string;
  categoryId: string;
  areaName: string;
  distanceKm: number | null;
  urgency: JobTiming;
  postedAt: string;
  hasVoiceNote: boolean;
  offersCount: number;
  isDirect: boolean;
  /** Direct requests only: when the customer's request lapses if nobody answers. */
  expiresAt?: string;
  /** Only present for appointments booked for a time (not "as soon as possible"). */
  scheduledFor?: string;
  /** Set when the lead was found because the worker's location changed, not because it was just posted. */
  reason?: 'LOCATION';
}

export interface LeadClosedPayload {
  id: string;
  reason: 'ASSIGNED' | 'CANCELLED' | 'EXPIRED';
}

export interface OfferPayload {
  jobId: string;
  offerId: string;
  visitFee: number;
  etaMinutes: number;
  message: string | null;
  status: string;
  worker: {
    id: string;
    name: string;
    rating: number | null;
    reviewsCount: number;
  };
}

export interface JobStatusPayload {
  jobId: string;
  status: JobStatus;
  at: string;
}

/** The booking is final: the worker is reserved for this window. Sent to the customer and the worker. */
export interface BookingConfirmedPayload {
  jobId: string;
  startAt: string;
  endAt: string;
  confirmedAt: string;
}

/** Asks the app to send a fresh location (if the person allowed it) because the worker is free again. */
export interface LocationRefreshPayload {
  reason: 'JOB_ENDED';
  jobId: string;
}

/**
 * The worker's position on the way to a job. `distanceKm` / `etaMinutes` are null unless BOTH the worker's
 * fix and the job's place have real coordinates; `distanceBasis` says how exact the job's place is.
 */
export interface JobLocationPayload {
  jobId: string;
  lat: number;
  lng: number;
  updatedAt: string;
  distanceKm: number | null;
  etaMinutes: number | null;
  distanceBasis: 'JOB_COORDINATES' | 'AREA_CENTROID' | null;
}

/** The itemised bill changed; the customer re-fetches `GET /jobs/:id/bill`. */
export interface BillUpdatedPayload {
  jobId: string;
  total: number;
}

/** The customer issued a new arrival code. Carries no code: the worker must ask the customer for it. */
export interface ArrivalCodeResetPayload {
  jobId: string;
}

/** The assigned worker backed out and the request is open for quotes again. */
export interface JobReopenedPayload {
  jobId: string;
  reason: 'WORKER_BACKED_OUT';
}
