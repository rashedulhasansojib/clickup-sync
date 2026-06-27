/**
 * Zoom WebVTT transcript parser.
 *
 * Real Zoom transcripts embed the speaker name in each cue's text as
 * `Speaker Name: utterance`, e.g.:
 *
 *   1
 *   00:00:17.480 --> 00:00:19.140
 *   Dan Leary: That's okay.
 *
 * We parse cues, split the speaker from the text, merge consecutive cues by the
 * same speaker into turns, and produce both a clean, timestamped transcript and
 * the list of distinct speaker labels (the basis for the roster).
 */

export interface Turn {
  speaker: string;
  text: string;
  /** Start time of the turn, in whole seconds. */
  startSec: number;
}

export interface NormalizedTranscript {
  isVtt: boolean;
  /** Clean transcript, one line per turn: `[mm:ss] Speaker: text`. */
  cleanTranscript: string;
  /** Distinct speaker labels in order of first appearance. */
  speakers: string[];
}

const TIMESTAMP_RE =
  /(\d{2}):(\d{2}):(\d{2})\.\d{3}\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.\d{3}/;

/** Looks like a Zoom/WebVTT file? */
export function isVtt(content: string): boolean {
  return /^﻿?WEBVTT/.test(content.trimStart());
}

function mmss(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Split a cue text line into speaker + utterance. Zoom uses `Name: text`.
 * Returns speaker=null when there's no plausible "Name:" prefix (treated as a
 * continuation of the previous speaker).
 */
function splitSpeaker(line: string): { speaker: string | null; text: string } {
  const idx = line.indexOf(":");
  if (idx <= 0) return { speaker: null, text: line };
  const candidate = line.slice(0, idx).trim();
  // A speaker label is short and single-line; long prefixes are almost certainly
  // sentences that merely contain a colon (e.g. "the ratio is 3:1").
  if (candidate.length === 0 || candidate.length > 60) {
    return { speaker: null, text: line };
  }
  return { speaker: candidate, text: line.slice(idx + 1).trim() };
}

/** Parse raw VTT into merged speaker turns. */
export function parseVttTurns(content: string): Turn[] {
  const lines = content.split(/\r?\n/);
  const turns: Turn[] = [];
  let pendingStart: number | null = null;
  let lastSpeaker = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (
      line === "" ||
      line.startsWith("WEBVTT") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      line.startsWith("NOTE") ||
      /^\d+$/.test(line)
    ) {
      continue;
    }

    const ts = line.match(TIMESTAMP_RE);
    if (ts) {
      pendingStart =
        parseInt(ts[1], 10) * 3600 + parseInt(ts[2], 10) * 60 + parseInt(ts[3], 10);
      continue;
    }

    // Text line for the current cue.
    const { speaker, text } = splitSpeaker(line);
    if (text === "") continue;
    const startSec = pendingStart ?? (turns.length ? turns[turns.length - 1].startSec : 0);
    const effectiveSpeaker = speaker ?? (lastSpeaker || "Unknown");

    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === effectiveSpeaker) {
      // Merge consecutive cues by the same speaker into one turn.
      prev.text += ` ${text}`;
    } else {
      turns.push({ speaker: effectiveSpeaker, text, startSec });
    }
    lastSpeaker = effectiveSpeaker;
    pendingStart = null;
  }

  return turns;
}

/**
 * Normalize any transcript input. If it's VTT, parse it into clean turns +
 * speakers. If it's plain text, pass it through unchanged (speakers unknown).
 */
export function normalize(content: string): NormalizedTranscript {
  if (!isVtt(content)) {
    return { isVtt: false, cleanTranscript: content.trim(), speakers: [] };
  }
  const turns = parseVttTurns(content);
  const speakers: string[] = [];
  for (const t of turns) {
    if (!speakers.includes(t.speaker)) speakers.push(t.speaker);
  }
  const cleanTranscript = turns
    .map((t) => `[${mmss(t.startSec)}] ${t.speaker}: ${t.text}`)
    .join("\n");
  return { isVtt: true, cleanTranscript, speakers };
}
