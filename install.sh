#!/usr/bin/env bash
set -euo pipefail

npm config set allow-scripts=9router --location=user
npm install --global 9router
