#!/bin/bash
# Wrapper script to run Perplexity MCP server with env from central .env file

# Load environment variables from central .env
ENV_FILE="$HOME/Projects/agent-kit/.env"

if [ -f "$ENV_FILE" ]; then
  # Export the Perplexity API key
  export PERPLEXITY_API_KEY="$(grep '^PERPLEXITY_API_KEY=' "$ENV_FILE" | cut -d'=' -f2-)"
fi

# Run the MCP server
exec npx -y @perplexity-ai/mcp-server
