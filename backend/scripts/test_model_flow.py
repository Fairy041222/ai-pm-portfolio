"""Integration test for model CRUD and message send."""
import asyncio
import json

import httpx

BASE = "http://127.0.0.1:8000/api"


async def main() -> None:
    async with httpx.AsyncClient(timeout=60.0) as client:
        # 1. List models - should be empty
        r = await client.get(f"{BASE}/models")
        r.raise_for_status()
        models = r.json()
        print("1. models count:", len(models))
        assert models == [], f"expected empty, got {models}"

        # 2. Create Deepseek model
        payload = {
            "name": "测试 Deepseek",
            "api_endpoint": "https://api.deepseek.com/v1",
            "api_key": "sk-test-key-12345",
        }
        r = await client.post(f"{BASE}/models", json=payload)
        r.raise_for_status()
        created = r.json()
        model_id = created["id"]
        print("2. created:", created["name"], created["apiEndpoint"])
        assert created["apiEndpoint"] == "https://api.deepseek.com/v1"
        assert created["hasApiKey"] is True

        # 3. GET detail
        r = await client.get(f"{BASE}/models/{model_id}")
        r.raise_for_status()
        detail = r.json()
        print("3. get detail endpoint:", detail["apiEndpoint"])
        assert detail["apiEndpoint"] == "https://api.deepseek.com/v1"

        # 4. Update endpoint and key
        r = await client.put(
            f"{BASE}/models/{model_id}",
            json={
                "name": "测试 Deepseek 已改",
                "api_endpoint": "https://api.deepseek.com/v1/chat/completions",
                "api_key": "sk-new-key-67890",
            },
        )
        r.raise_for_status()
        updated = r.json()
        print("4. updated:", updated["name"], updated["apiEndpoint"])
        assert updated["name"] == "测试 Deepseek 已改"
        assert "deepseek.com" in updated["apiEndpoint"]
        assert updated["hasApiKey"] is True

        # 5. Re-open edit (GET again)
        r = await client.get(f"{BASE}/models/{model_id}")
        r.raise_for_status()
        again = r.json()
        print("5. reopen:", again["name"], again["apiEndpoint"])
        assert again["name"] == updated["name"]
        assert again["apiEndpoint"] == updated["apiEndpoint"]

        # 6. Create conversation and send message (may fail LLM but should not 500)
        r = await client.post(f"{BASE}/conversations")
        r.raise_for_status()
        conv_id = r.json()["id"]
        r = await client.post(
            f"{BASE}/conversations/{conv_id}/messages",
            json={
                "content": "你好",
                "question": "你好",
                "model_ids": [model_id],
            },
        )
        print("6. send message status:", r.status_code)
        body = r.json()
        print("6. response type:", body.get("type"), "content preview:", str(body.get("content", ""))[:80])
        assert r.status_code == 200, body
        assert body.get("type") == "text"

        print("\nAll integration checks passed.")


if __name__ == "__main__":
    asyncio.run(main())
