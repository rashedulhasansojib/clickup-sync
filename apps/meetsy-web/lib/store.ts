import type { CreateMeetingResponse } from "@ma/shared";

/**
 * Tiny client-side handoff store for the upload → roster step.
 *
 * Why this exists: the API has no `GET /meetings/:id`, so the extracted roster
 * only ever arrives inside the `POST /meetings` response. We stash it (keyed by
 * meetingId) in sessionStorage so the roster page can read it — and so it
 * survives a page refresh. The run page is self-sufficient via `GET /runs/:id`
 * and does not depend on this store.
 */

const keyFor = (meetingId: string) => `ma:meeting:${meetingId}`;

export function saveMeeting(data: CreateMeetingResponse): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(keyFor(data.meetingId), JSON.stringify(data));
  } catch {
    // sessionStorage may be unavailable (private mode / quota); roster page
    // will simply show an empty editable list instead.
  }
}

export function loadMeeting(meetingId: string): CreateMeetingResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(keyFor(meetingId));
    return raw ? (JSON.parse(raw) as CreateMeetingResponse) : null;
  } catch {
    return null;
  }
}

export function clearMeeting(meetingId: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(keyFor(meetingId));
  } catch {
    // ignore
  }
}
