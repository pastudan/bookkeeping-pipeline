#!/usr/bin/env bash

# Start Fava web interface for viewing beancount books

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTITY_ROOT="$(cd "$PIPELINE_DIR/.." && pwd)"

echo "Starting Fava web interface..."
echo "Open http://localhost:5050 in your browser"
echo ""

cd "$ENTITY_ROOT"
docker-compose up -d

echo ""
echo "Fava is now running!"
echo "  View your books at: http://localhost:5050"
echo ""
echo "To stop Fava, run: docker-compose down"
