#!/usr/bin/env python3
"""Connect a locally administered Docker Dify workspace through its provider service."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

# Run inside the already running API container; credentials travel only through
# stdin, never shell interpolation, process arguments or temporary plaintext files.
# This is an administrator setup operation, not a console authentication bypass.
REMOTE = r'''
import json, sys
payload = json.load(sys.stdin)
try:
    from app_factory import create_app
    from extensions.ext_database import db
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from models.account import Tenant
    from models.provider import ProviderCredential
    from services.model_provider.service import ModelProviderService
    from graphon.model_runtime.entities.model_entities import ModelType
    from graphon.model_runtime.entities.message_entities import UserPromptMessage
    from core.plugin.impl.model_runtime_factory import create_plugin_model_manager

    _, app = create_app()
    with app.app_context():
        with Session(db.engine) as session:
            workspaces = list(session.scalars(select(Tenant.id)))
            tenant_id = payload.get("workspace")
            if tenant_id:
                if tenant_id not in workspaces:
                    raise ValueError("Requested workspace does not exist.")
            elif len(workspaces) == 1:
                tenant_id = workspaces[0]
            else:
                raise ValueError("Specify --workspace UUID when Dify has zero or multiple workspaces.")
            existing = session.scalar(select(ProviderCredential.id).where(
                ProviderCredential.tenant_id == tenant_id,
                ProviderCredential.provider_name == payload["provider"],
                ProviderCredential.credential_name == "Local ChatGPT",
            ))
        service = ModelProviderService()
        if existing:
            service.update_provider_credential(tenant_id=tenant_id, provider=payload["provider"],
                credentials=payload["credentials"], credential_id=existing, credential_name="Local ChatGPT")
            credential_id = existing
        else:
            credential_id = service.create_provider_credential(tenant_id=tenant_id, provider=payload["provider"],
                credentials=payload["credentials"], credential_name="Local ChatGPT")
        service.switch_active_provider_credential(tenant_id, payload["provider"], credential_id)
        service.switch_preferred_provider(tenant_id, payload["provider"], "custom")
        service.update_default_model_of_model_type(tenant_id, "llm", payload["provider"], payload["model"])
        instance = create_plugin_model_manager(tenant_id=tenant_id).get_model_instance(tenant_id=tenant_id, provider=payload["provider"],
            model_type=ModelType.LLM, model=payload["model"])
        result = instance.invoke_llm(prompt_messages=[UserPromptMessage(content="Reply with exactly: Dify connection works.")],
            model_parameters={}, stream=False)
        content = result.message.content
        if not content:
            raise RuntimeError("Dify returned an empty response.")
        chunks = instance.invoke_llm(prompt_messages=[UserPromptMessage(content="Reply with exactly: Streaming works.")],
            model_parameters={}, stream=True)
        streamed = "".join(chunk.delta.message.content for chunk in chunks if isinstance(chunk.delta.message.content, str))
        if not streamed:
            raise RuntimeError("Dify returned an empty streaming response.")
        print(json.dumps({"configured": True, "workspace": tenant_id, "provider": payload["provider"],
            "model": payload["model"], "reply": content, "streaming_reply": streamed}))
except Exception as error:
    # No traceback or credential payload in setup diagnostics.
    import traceback
    print(json.dumps({"configured": False, "error_type": type(error).__name__,
        "location": [{"file": frame.filename, "line": frame.lineno, "function": frame.name} for frame in traceback.extract_tb(error.__traceback__)[-3:]],
        "message": str(error).replace(payload["credentials"]["openai_api_key"], "[local-key]") if isinstance(error, (ValueError, TypeError)) else "Dify provider setup or inference failed; inspect sanitized service diagnostics."}))
    sys.exit(1)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", help="Exact account model slug; defaults to the first available model.")
    parser.add_argument("--workspace", help="Workspace UUID; required if more than one workspace exists.")
    args = parser.parse_args()
    command = [shutil.which("node") or "node", str(ROOT / "manage.mjs"), "config"]
    if args.model:
        command.append(args.model)
    local = subprocess.run(command, capture_output=True, text=True)
    if local.returncode:
        raise SystemExit("Could not load the ChatGPT model catalog. Complete login and run models first.")
    payload = json.loads(local.stdout)
    payload["workspace"] = args.workspace
    result = subprocess.run(["docker", "compose", "exec", "-T", "api", "uv", "--cache-dir", "/tmp/dify-chatgpt-uv", "run", "--offline", "--no-sync", "--project", "/app/api", "python", "-c", REMOTE],
                            cwd=ROOT.parent, input=json.dumps(payload), capture_output=True, text=True)
    # Runtime logging can precede the final result. Only publish our result record.
    records = []
    for line in result.stdout.splitlines():
        try:
            record = json.loads(line)
            if isinstance(record, dict) and "configured" in record:
                records.append(record)
        except ValueError:
            continue
    if records:
        print(json.dumps(records[-1], indent=2, ensure_ascii=False))
    else:
        print("Dify setup did not return a result. Verify the API container, uv and provider-service version.", file=sys.stderr)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
