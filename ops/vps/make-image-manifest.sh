#!/bin/bash
# ops/vps/make-image-manifest.sh — names the images a release ships (finding F2).
#
#   make-image-manifest.sh <tag> <images.tar.gz> > ops/RELEASE_IMAGES
#
# Run by the deploy workflow after the tests passed on these exact images, with
# nurseapp/{api,migrate,web}:<tag> still in the local Docker. The bundle carries the
# file; deploy.sh load refuses images.tar.gz unless its sha256 is the one written here,
# so the VPS runs the bytes that were tested. The image IDs are for the release record
# (the classic and containerd image stores number the same image differently, so they
# are not compared).

set -euo pipefail

TAG="${1:-}"; FILE="${2:-}"
[[ "$TAG" =~ ^[A-Za-z0-9._-]{1,128}$ && -f "$FILE" ]] || { echo "usage: $0 <tag> <images.tar.gz>" >&2; exit 2; }

echo "tag $TAG"
echo "sha256 $(sha256sum "$FILE" | cut -d' ' -f1)"
for image in api migrate web; do
  echo "$image $(docker image inspect -f '{{.Id}}' "nurseapp/$image:$TAG")"
done
