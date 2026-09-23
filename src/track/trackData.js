// STUB — owned by Agent 2 (Tracks & Environment). Replace with 3 full track definitions.
import { TRACKS } from '../contracts.js';

function oval({ radiusX = 140, radiusZ = 90, count = 20, y = 0 }) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * radiusX, y, z: Math.sin(a) * radiusZ });
  }
  return pts;
}

const defs = {
  'sunset-speedway': { ...TRACKS[0], width: 16, points: oval({}), elevation: 0 },
  'desert-dunes': { ...TRACKS[1], width: 15, points: oval({ radiusX: 150, radiusZ: 100 }), elevation: 0 },
  'frozen-peaks': { ...TRACKS[2], width: 14, points: oval({ radiusX: 130, radiusZ: 95 }), elevation: 0 },
};

export function getTrack(id) { return defs[id] || defs['sunset-speedway']; }
export const TRACK_DEFS = defs;
