#!/usr/bin/env bash

set -euo pipefail

OUTPUT_FILE="${1:-}"

# Read raw curl command from stdin if piped, otherwise from the clipboard
if [ -t 0 ]; then
  RAW_CURL=$(pbpaste)
else
  RAW_CURL=$(cat)
fi

if [[ -z "$RAW_CURL" ]]; then
  echo "Error: No curl command provided." >&2
  exit 1
fi

# 1. Extract Target URL
URL=$(echo "$RAW_CURL" | grep -oE "https://lrscdn\.mcgill\.ca/api/tsmedia/[^'\" ]+" | head -n 1)

if [[ -z "$URL" ]]; then
  echo "Error: Could not parse McGill media URL from input." >&2
  exit 1
fi

# 2. Extract RID for default filename
RID=$(echo "$URL" | grep -oE "rid=[a-f0-9-]+" | cut -d'=' -f2 || true)

# Cache: maps RID -> saved recording filename (tab-separated), next to the script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/.cache"
CACHE_FILE="$CACHE_DIR/recordings.tsv"
CACHE_KEY="${RID:-$URL}"   # fall back to the full URL if there's no RID
mkdir -p "$CACHE_DIR"
touch "$CACHE_FILE"

CACHED_NAME=$(awk -F'\t' -v k="$CACHE_KEY" '$1 == k { print $2; exit }' "$CACHE_FILE")
if [[ -n "$CACHED_NAME" ]]; then
  echo "==> RID ${CACHE_KEY} and saved recording \"${CACHED_NAME}\" are already associated together."
  read -r -p "Continue anyway? [y/N]: " CONFIRM < /dev/tty || true
  if [[ ! "$CONFIRM" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Prompt for a filename (via the terminal, since stdin is the piped curl command)
if [[ -z "$OUTPUT_FILE" ]]; then
  if [[ -n "$RID" ]]; then
    DEFAULT_NAME="lecture_${RID}.mp3"
  else
    DEFAULT_NAME="lecture_audio.mp3"
  fi
  read -r -p "Output filename [${DEFAULT_NAME}]: " OUTPUT_FILE < /dev/tty || true
  OUTPUT_FILE="${OUTPUT_FILE:-$DEFAULT_NAME}"
fi

if [[ "$OUTPUT_FILE" != *.mp3 ]]; then
  OUTPUT_FILE="${OUTPUT_FILE}.mp3"
fi

# Save into a "Recordings" folder next to this script
RECORDINGS_DIR="$SCRIPT_DIR/Recordings"
mkdir -p "$RECORDINGS_DIR"
OUTPUT_FILE="$RECORDINGS_DIR/$(basename "$OUTPUT_FILE")"

# 3. Extract Cookie (if present)
COOKIE=$(echo "$RAW_CURL" | grep -iE "\-H ['\"]Cookie:" | sed -E "s/.*-H ['\"][Cc]ookie: *([^'\"]+)['\"].*/\1/" | head -n 1)

# Build cookie header array for curl
COOKIE_ARGS=()
if [[ -n "$COOKIE" ]]; then
  COOKIE_ARGS=(-H "Cookie: $COOKIE")
fi

echo "==> URL detected: $URL"
echo "==> Fetching total stream size from server headers..."

# 4. Probe total file size by requesting 1 byte (bytes=0-0)
# The server responds with HTTP 206 and 'Content-Range: bytes 0-0/<total_bytes>'
HEADER_DUMP=$(curl -sI \
  -H "Range: bytes=0-0" \
  -H "Referer: https://lrs.mcgill.ca/" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" \
  "${COOKIE_ARGS[@]}" \
  "$URL" || true)

TOTAL_BYTES=$(echo "$HEADER_DUMP" | grep -i "content-range:" | grep -oE "/[0-9]+" | tr -d '/' | head -n 1)

if [[ -z "$TOTAL_BYTES" ]]; then
  echo "Warning: Could not detect Content-Range header from probe."
  echo "Attempting open-ended range bytes=0- ..."
  RANGE_VAL="bytes=0-"
else
  UPPER_BYTE=$((TOTAL_BYTES - 1))
  RANGE_VAL="bytes=0-${UPPER_BYTE}"
  SIZE_MB=$(echo "scale=2; $TOTAL_BYTES / 1048576" | bc)
  echo "==> Detected total video stream size: ${SIZE_MB} MB ($TOTAL_BYTES bytes)"
fi

echo "==> Target output: $OUTPUT_FILE"
echo "==> Streaming and encoding to MP3 in memory..."

# 5. Stream directly into FFmpeg
curl -sL \
  -H "Range: $RANGE_VAL" \
  -H "Referer: https://lrs.mcgill.ca/" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" \
  "${COOKIE_ARGS[@]}" \
  "$URL" \
  | ffmpeg -y -hide_banner -loglevel warning -stats \
      -i pipe:0 \
      -vn \
      -c:a libmp3lame \
      -q:a 4 \
      "$OUTPUT_FILE"

# 6. Record in cache (replacing any previous entry for this key, keeping 1:1)
TMP_CACHE=$(mktemp)
awk -F'\t' -v k="$CACHE_KEY" '$1 != k' "$CACHE_FILE" > "$TMP_CACHE" || true
printf '%s\t%s\n' "$CACHE_KEY" "$(basename "$OUTPUT_FILE")" >> "$TMP_CACHE"
mv "$TMP_CACHE" "$CACHE_FILE"

echo "==> Extraction finished: $OUTPUT_FILE"