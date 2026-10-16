import type {Timestamp} from '@bufbuild/protobuf/wkt'

/** Round down so a returned Date can be reused as an inclusive replay cutoff. */
export function logTimestamp(timestamp: Timestamp): Date {
  return new Date(Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000))
}
