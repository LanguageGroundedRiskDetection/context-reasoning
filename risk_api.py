"""Python functions for object-centric image risk analysis.

The public APIs return JSON-compatible dictionaries and never include model
explanations. No HTTP server or third-party Python package is required.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-5.4-nano"
DEFAULT_CANDIDATES = ("baby", "coin", "sofa", "table", "TV")
ALLOWED_MODELS = {
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5-nano",
}


class RiskAPIError(RuntimeError):
    """Raised when a risk-analysis API call fails."""


class RiskAnalyzer:
    """Run the extraction, grouping, and scoring pipeline.

    Args:
        api_key: OpenAI API key. If omitted, ``OPENAI_API_KEY`` is used.
        model: One of the supported vision-capable GPT model IDs.
        timeout: Request timeout in seconds.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = DEFAULT_MODEL,
        timeout: float = 120.0,
    ) -> None:
        if model not in ALLOWED_MODELS:
            allowed = ", ".join(sorted(ALLOWED_MODELS))
            raise ValueError(f"Unsupported model {model!r}. Choose one of: {allowed}")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def extract_objects(
        self,
        image: str | os.PathLike[str] | bytes,
        *,
        object_count: int = 10,
        candidates: Sequence[str] | None = None,
        fast: bool = False,
        image_mime: str = "image/png",
    ) -> list[str]:
        """Extract object names or check candidate presence.

        Fast mode sends one batched y/n request. If no candidates are supplied,
        ``DEFAULT_CANDIDATES`` is used.
        """

        image_data_url = _image_data_url(image, image_mime)
        reasoning_effort = _fast_reasoning_effort(self.model) if fast else None

        if fast:
            names = _unique_names(candidates or DEFAULT_CANDIDATES, limit=50)
            if not names:
                raise ValueError("Fast mode requires at least one candidate object.")
            result = self._call_openai(
                system="Classify whether each named object is visible in the image.",
                user_text=(
                    f"Candidates in order: {json.dumps(names)}\n"
                    "Return one lowercase y or n for each candidate in the same "
                    "order. No explanations."
                ),
                schema=_presence_schema(len(names)),
                image_data_url=image_data_url,
                image_detail="low",
                reasoning_effort=reasoning_effort,
            )
            presence = result["presence"]
            return [name for index, name in enumerate(names) if presence[index] == "y"]

        if not 1 <= object_count <= 50:
            raise ValueError("object_count must be between 1 and 50.")
        result = self._call_openai(
            system="List visible physical entities using unique one or two-word names.",
            user_text=(
                f"Return exactly {object_count} distinct visible object names. "
                "Include people, animals, small loose items, furniture, containers, "
                "surfaces, and room features. No explanations."
            ),
            schema=_object_list_schema(object_count),
            image_data_url=image_data_url,
            image_detail="high",
        )
        return _unique_names(result["objects"], limit=object_count)

    def group_objects(
        self,
        risk_description: str,
        objects: Sequence[str],
        *,
        fast: bool = False,
    ) -> dict[str, list[str]]:
        """Partition object names into victims and risk objects."""

        names = _unique_names(objects, limit=50)
        if not names:
            return {"victims": [], "risk_objects": []}
        if not risk_description.strip():
            raise ValueError("risk_description cannot be empty.")

        result = self._call_openai(
            system=(
                "Partition entities for a risk. A victim is the entity that would "
                "suffer harm, not the hazard source. Victims may be people, animals, "
                "robots, objects, or materials, and may be empty."
            ),
            user_text=(
                f"Risk: {risk_description.strip()}\n"
                f"Names: {json.dumps(names)}\n"
                "Return exact names in victims or risk_objects. Choking: child=victim, "
                "coin=object. Fire: paper or wooden furniture may be victims. "
                "No explanations."
            ),
            schema=_grouping_schema(),
            reasoning_effort=_fast_reasoning_effort(self.model) if fast else None,
        )

        victim_keys = {name.casefold() for name in result["victims"]}
        victims = [name for name in names if name.casefold() in victim_keys]
        victim_keys = {name.casefold() for name in victims}
        risk_objects = [name for name in names if name.casefold() not in victim_keys]
        return {"victims": victims, "risk_objects": risk_objects}

    def score_risks(
        self,
        risk_description: str,
        victims: Sequence[str],
        risk_objects: Sequence[str],
        *,
        fast: bool = False,
    ) -> dict[str, Any]:
        """Return one numeric score for every victim-object pair."""

        victim_names = _unique_names(victims, limit=50)
        object_names = _unique_names(risk_objects, limit=50)
        if not victim_names or not object_names:
            return {"scores": [], "overall_score": 0.0}
        if not risk_description.strip():
            raise ValueError("risk_description cannot be empty.")

        result = self._call_openai(
            system="Return only a 0-to-1 risk score for each victim-object pair.",
            user_text=(
                f"Risk: {risk_description.strip()}\n"
                f"Victims: {json.dumps(victim_names)}\n"
                f"Objects: {json.dumps(object_names)}\n"
                "Return a score matrix in this exact order. No explanations."
            ),
            schema=_score_matrix_schema(len(victim_names), len(object_names)),
            reasoning_effort=_fast_reasoning_effort(self.model) if fast else None,
        )

        scores: list[dict[str, Any]] = []
        for victim_index, victim in enumerate(victim_names):
            for object_index, risk_object in enumerate(object_names):
                score = _clamp_score(result["scores"][victim_index][object_index])
                scores.append(
                    {"victim": victim, "object": risk_object, "score": score}
                )
        overall_score = max((item["score"] for item in scores), default=0.0)
        return {"scores": scores, "overall_score": overall_score}

    def analyze(
        self,
        image: str | os.PathLike[str] | bytes,
        risk_description: str,
        *,
        object_count: int = 10,
        candidates: Sequence[str] | None = None,
        fast: bool = False,
        image_mime: str = "image/png",
    ) -> dict[str, Any]:
        """Run the complete pipeline and return a JSON-compatible result."""

        objects = self.extract_objects(
            image,
            object_count=object_count,
            candidates=candidates,
            fast=fast,
            image_mime=image_mime,
        )
        groups = self.group_objects(risk_description, objects, fast=fast)
        scoring = self.score_risks(
            risk_description,
            groups["victims"],
            groups["risk_objects"],
            fast=fast,
        )
        return {
            "objects": objects,
            "victims": groups["victims"],
            "risk_objects": groups["risk_objects"],
            "scores": scoring["scores"],
            "overall_score": scoring["overall_score"],
        }

    def _call_openai(
        self,
        *,
        system: str,
        user_text: str,
        schema: dict[str, Any],
        image_data_url: str | None = None,
        image_detail: str = "high",
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        api_key = (self.api_key or os.environ.get("OPENAI_API_KEY", "")).strip()
        if not api_key:
            raise RiskAPIError(
                "Provide api_key to RiskAnalyzer or set OPENAI_API_KEY."
            )

        content: list[dict[str, Any]] = [
            {"type": "input_text", "text": user_text}
        ]
        if image_data_url:
            content.append(
                {
                    "type": "input_image",
                    "image_url": image_data_url,
                    "detail": image_detail,
                }
            )

        payload: dict[str, Any] = {
            "model": self.model,
            "input": [
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": system}],
                },
                {"role": "user", "content": content},
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema["name"],
                    "strict": True,
                    "schema": schema["schema"],
                }
            },
        }
        if reasoning_effort:
            payload["reasoning"] = {"effort": reasoning_effort}

        request = Request(
            OPENAI_RESPONSES_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=self.timeout) as response:
                response_json = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            try:
                message = json.loads(body).get("error", {}).get("message", body)
            except json.JSONDecodeError:
                message = body
            raise RiskAPIError(f"OpenAI request failed ({error.code}): {message}") from error
        except (URLError, TimeoutError) as error:
            raise RiskAPIError(f"OpenAI request failed: {error}") from error

        output_text = _extract_output_text(response_json)
        if not output_text:
            raise RiskAPIError("The model returned no structured output.")
        try:
            return json.loads(output_text)
        except json.JSONDecodeError as error:
            raise RiskAPIError("The model returned invalid JSON.") from error


def extract_objects(
    image: str | os.PathLike[str] | bytes,
    *,
    object_count: int = 10,
    candidates: Sequence[str] | None = None,
    fast: bool = False,
    image_mime: str = "image/png",
    api_key: str | None = None,
    model: str = DEFAULT_MODEL,
) -> list[str]:
    """Convenience wrapper for :meth:`RiskAnalyzer.extract_objects`."""

    return RiskAnalyzer(api_key=api_key, model=model).extract_objects(
        image,
        object_count=object_count,
        candidates=candidates,
        fast=fast,
        image_mime=image_mime,
    )


def group_objects(
    risk_description: str,
    objects: Sequence[str],
    *,
    fast: bool = False,
    api_key: str | None = None,
    model: str = DEFAULT_MODEL,
) -> dict[str, list[str]]:
    """Convenience wrapper for :meth:`RiskAnalyzer.group_objects`."""

    return RiskAnalyzer(api_key=api_key, model=model).group_objects(
        risk_description, objects, fast=fast
    )


def score_risks(
    risk_description: str,
    victims: Sequence[str],
    risk_objects: Sequence[str],
    *,
    fast: bool = False,
    api_key: str | None = None,
    model: str = DEFAULT_MODEL,
) -> dict[str, Any]:
    """Convenience wrapper for :meth:`RiskAnalyzer.score_risks`."""

    return RiskAnalyzer(api_key=api_key, model=model).score_risks(
        risk_description, victims, risk_objects, fast=fast
    )


def analyze_risk(
    image: str | os.PathLike[str] | bytes,
    risk_description: str,
    *,
    object_count: int = 10,
    candidates: Sequence[str] | None = None,
    fast: bool = False,
    image_mime: str = "image/png",
    api_key: str | None = None,
    model: str = DEFAULT_MODEL,
) -> dict[str, Any]:
    """Convenience function for the complete pipeline."""

    return RiskAnalyzer(api_key=api_key, model=model).analyze(
        image,
        risk_description,
        object_count=object_count,
        candidates=candidates,
        fast=fast,
        image_mime=image_mime,
    )


def _image_data_url(
    image: str | os.PathLike[str] | bytes, image_mime: str
) -> str:
    if isinstance(image, str) and image.startswith("data:image/"):
        return image

    if isinstance(image, bytes):
        data = image
        mime_type = image_mime
    else:
        path = Path(image)
        if not path.is_file():
            raise ValueError(f"Image file does not exist: {path}")
        data = path.read_bytes()
        mime_type = mimetypes.guess_type(path.name)[0] or image_mime

    if not mime_type.startswith("image/"):
        raise ValueError(f"Unsupported image MIME type: {mime_type}")
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _unique_names(names: Iterable[str], limit: int) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in names:
        name = str(value).strip()
        key = name.casefold()
        if not name or key in seen:
            continue
        seen.add(key)
        result.append(name)
        if len(result) >= limit:
            break
    return result


def _extract_output_text(response_json: dict[str, Any]) -> str:
    if response_json.get("output_text"):
        return str(response_json["output_text"])
    parts: list[str] = []
    for item in response_json.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                parts.append(content["text"])
    return "\n".join(parts)


def _fast_reasoning_effort(model: str) -> str:
    return "minimal" if model == "gpt-5-nano" else "none"


def _clamp_score(value: Any) -> float:
    return max(0.0, min(1.0, float(value)))


def _presence_schema(candidate_count: int) -> dict[str, Any]:
    return {
        "name": "object_presence",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["presence"],
            "properties": {
                "presence": {
                    "type": "array",
                    "minItems": candidate_count,
                    "maxItems": candidate_count,
                    "items": {"type": "string", "enum": ["y", "n"]},
                }
            },
        },
    }


def _object_list_schema(object_count: int) -> dict[str, Any]:
    return {
        "name": "scene_object_names",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["objects"],
            "properties": {
                "objects": {
                    "type": "array",
                    "minItems": object_count,
                    "maxItems": object_count,
                    "items": {"type": "string"},
                }
            },
        },
    }


def _grouping_schema() -> dict[str, Any]:
    return {
        "name": "risk_object_groups",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["victims", "risk_objects"],
            "properties": {
                "victims": {"type": "array", "items": {"type": "string"}},
                "risk_objects": {"type": "array", "items": {"type": "string"}},
            },
        },
    }


def _score_matrix_schema(victim_count: int, object_count: int) -> dict[str, Any]:
    return {
        "name": "victim_object_scores",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["scores"],
            "properties": {
                "scores": {
                    "type": "array",
                    "minItems": victim_count,
                    "maxItems": victim_count,
                    "items": {
                        "type": "array",
                        "minItems": object_count,
                        "maxItems": object_count,
                        "items": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                }
            },
        },
    }


__all__ = [
    "ALLOWED_MODELS",
    "DEFAULT_CANDIDATES",
    "DEFAULT_MODEL",
    "RiskAPIError",
    "RiskAnalyzer",
    "analyze_risk",
    "extract_objects",
    "group_objects",
    "score_risks",
]
