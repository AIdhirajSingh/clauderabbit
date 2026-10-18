#!/usr/bin/env bash
# cr-drops.sh <comment>: packets counted by the inner fence's drop rule tagged
# with that comment (table inet cr, chain out_filter). Prints 0 when the table or
# the rule is absent. Root only (reads the nftables ruleset).
set -uo pipefail
n=$(nft -j list chain inet cr out_filter 2>/dev/null \
  | jq --arg c "$1" '[.nftables[] | .rule? | select(. != null and .comment == $c) | .expr[] | .counter? | select(. != null) | .packets] | add // 0' 2>/dev/null)
[[ "$n" =~ ^[0-9]+$ ]] && echo "$n" || echo 0
