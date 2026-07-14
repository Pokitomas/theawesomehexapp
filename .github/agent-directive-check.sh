- name: Agent directive pre-check
  run: |
    echo "Checking agent directive..."
    DIRECTIVE_JSON=$(curl -fsS --max-time 5 "https://${NETLIFY_SITE_DOMAIN}/.netlify/functions/agent-directive" || echo '{}')
    directive=$(echo "$DIRECTIVE_JSON" | jq -r '.directive.directive // ""')
    target_run=$(echo "$DIRECTIVE_JSON" | jq -r '.directive.target_run // ""')
    if [ "$directive" = "interrupt" ]; then
      echo "Agent directive: interrupt (target: $target_run). Skipping dangerous steps."
      exit 0
    fi
    echo "No interrupt directive present; continuing."
