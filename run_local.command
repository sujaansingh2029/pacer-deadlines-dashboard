#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Starting Advanced DD Brief Generator locally..."
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -r requirements.txt
python3 server.py
