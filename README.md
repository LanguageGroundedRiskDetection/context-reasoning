# Object-Centric Risk Demo

A local webpage for extracting image objects, grouping them into victims and risk-contributing objects, and scoring each victim-object pair.

## Run

### Prerequisites

- Node.js 18 or newer
- An OpenAI API key

### Start Locally

1. From the repository root, start the server:

```bash
./run.sh
```

Alternatively, use npm or Node.js directly:

```bash
npm start
# or
node server.js
```

2. Open:

```text
http://127.0.0.1:5173
```

3. Enter your OpenAI API key in the webpage. It is kept only for the current page visit and is not saved by the app.

The server binds to `127.0.0.1` by default. To use another port:

```bash
PORT=8080 npm start
```

## Flow

```text
risk description + image
-> extract visible objects
-> group into victims and objects
-> score every victim-object pair
-> aggregate per victim
```

The default model is `gpt-5.4-nano`. The webpage also provides a model selector. Override the server fallback with:

```bash
OPENAI_MODEL=your-model node server.js
```

## Python API

`risk_api.py` provides importable Python functions without an HTTP server or third-party dependencies.

```python
from risk_api import analyze_risk

result = analyze_risk(
    "public/assets/baby.png",
    "choking hazard",
    fast=True,
    candidates=["baby", "coin", "sofa", "table", "TV"],
)
```

Set `OPENAI_API_KEY` in the environment or pass `api_key=` directly. The returned dictionary contains object names, groups, pair scores, and the overall maximum score without explanations.
