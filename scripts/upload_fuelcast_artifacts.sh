#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_URL:?Set SUPABASE_URL for the Supabase project}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY locally; never expose it to the browser}"
FUELCAST_STORAGE_BUCKET="${FUELCAST_STORAGE_BUCKET:-fuelcast-private}"
ARTIFACT_DIR="${FUELCAST_ARTIFACT_DIR:-.local/fuelcast}"

for file_name in fuelcast_model.joblib validation.json; do
  artifact_path="${ARTIFACT_DIR}/${file_name}"
  if [[ ! -f "${artifact_path}" ]]; then
    printf 'Missing local artifact: %s\n' "${artifact_path}" >&2
    exit 1
  fi
  curl --fail --silent --show-error \
    --request POST \
    "${SUPABASE_URL%/}/storage/v1/object/${FUELCAST_STORAGE_BUCKET}/${file_name}" \
    --header "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    --header "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    --header 'Content-Type: application/octet-stream' \
    --header 'x-upsert: true' \
    --data-binary "@${artifact_path}" \
    --output /dev/null
  printf 'Uploaded %s to private bucket %s\n' "${file_name}" "${FUELCAST_STORAGE_BUCKET}"
done

printf 'FUELCAST_MODEL_SHA256='
sha256sum "${ARTIFACT_DIR}/fuelcast_model.joblib" | cut -d ' ' -f 1
