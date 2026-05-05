#!/bin/bash
# Synchronisation TikTok Ads + RevenueCat + ASC + PostHog → Google Sheets
# Usage: ./sync.sh

cd "$(dirname "$0")"
node sync.js
