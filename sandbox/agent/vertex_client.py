#!/usr/bin/env python3
"""
vertex_client.py — the thin, LAZY Vertex model client for the agent loop.

This is the ONLY place the real `google-genai` SDK is imported, and it is
imported lazily INSIDE the call (never at module import). That keeps the agent
loop and its unit tests stdlib-only: tests inject a mock `model_call` and never
touch this file, so the SDK is not a test dependency (audit: deterministic,
no-network tests).

Models (see docs/INFRASTRUCTURE.md for the authoritative strings):
  - lead    = gemini-3.1-flash-lite  (the explore/detonate executor)
  - advisor = gemini-3.5-flash       (the capped hard-decision advisor)

Backend = Vertex via ADC: genai.Client(vertexai=True, project=..., location=...).
Auth is Application Default Credentials on the controller (the same ADC
orchestrate.sh already relies on). No keys live here or in the repo.

The public surface is a single callable shaped exactly like the `model_call`
the agent loop expects:

    model_call(system: str, messages: list[dict], tools: list[dict]) -> response

`response` is a small plain dict the loop understands:
    {"text": str, "tool_calls": [{"name": str, "arguments": dict}, ...],
     "usage": {"total_tokens": int}}
so the loop never depends on the SDK's response object shape.
"""
from __future__ import annotations

from typing import Any

# Authoritative model strings (see docs/INFRASTRUCTURE.md).
LEAD_MODEL = "gemini-3.1-flash-lite"
ADVISOR_MODEL = "gemini-3.5-flash"


def make_vertex_model_call(
    *,
    project: str,
    location: str,
    model: str = LEAD_MODEL,
) -> Any:
    """Return a `model_call(system, messages, tools) -> response` bound to Vertex.

    The google-genai SDK is imported INSIDE this factory so importing this module
    (or the agent loop) never requires the SDK. Only calling the returned closure
    at real runtime touches Vertex.
    """

    def model_call(system: str, messages: list[dict], tools: list[dict]) -> dict:
        # Lazy import: tests never reach here, so the SDK stays optional.
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore

        client = genai.Client(vertexai=True, project=project, location=location)

        # Map the loop's neutral message list onto SDK content. The system prompt
        # is a fixed constant supplied by the loop (audit C3) and goes ONLY into
        # system_instruction, never mixed with untrusted message content.
        contents = _to_contents(types, messages)
        tool_defs = _to_tools(types, tools)

        config = types.GenerateContentConfig(
            system_instruction=system,
            tools=tool_defs or None,
            temperature=0,
        )
        resp = client.models.generate_content(
            model=model, contents=contents, config=config
        )
        return _normalize_response(resp)

    return model_call


def _to_contents(types: Any, messages: list[dict]) -> list:
    """Translate neutral {role, content} messages into SDK Content parts."""
    out = []
    for m in messages:
        role = "model" if m.get("role") == "assistant" else "user"
        out.append(
            types.Content(role=role, parts=[types.Part.from_text(text=str(m.get("content", "")))])
        )
    return out


def _to_tools(types: Any, tools: list[dict]) -> list:
    """Translate the loop's tool descriptors into SDK function declarations."""
    if not tools:
        return []
    decls = []
    for t in tools:
        decls.append(
            types.FunctionDeclaration(
                name=t["name"],
                description=t.get("description", ""),
                parameters=t.get("parameters"),
            )
        )
    return [types.Tool(function_declarations=decls)]


def _normalize_response(resp: Any) -> dict:
    """Reduce the SDK response to the loop's small dict contract."""
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    try:
        for cand in getattr(resp, "candidates", []) or []:
            content = getattr(cand, "content", None)
            for part in getattr(content, "parts", []) or []:
                fc = getattr(part, "function_call", None)
                if fc is not None:
                    tool_calls.append(
                        {"name": fc.name, "arguments": dict(fc.args or {})}
                    )
                elif getattr(part, "text", None):
                    text_parts.append(part.text)
    except (AttributeError, TypeError):
        pass

    total_tokens = 0
    usage = getattr(resp, "usage_metadata", None)
    if usage is not None:
        total_tokens = int(getattr(usage, "total_token_count", 0) or 0)

    return {
        "text": "".join(text_parts),
        "tool_calls": tool_calls,
        "usage": {"total_tokens": total_tokens},
    }
