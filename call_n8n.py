
# Easy webhook to get an n8n response



import requests

def main():
    # TODO: replace this with your actual n8n Webhook URL
    WEBHOOK_URL = "https://hudmarr.app.n8n.cloud/webhook/fb613c07-aa88-4fbd-a3c9-ba4cdf7387a9"

    # 1) Prompt the user for input
    user_input = input("Enter your message to n8n: ")

    # 2) Send it to n8n
    try:
        response = requests.post(
            WEBHOOK_URL,
            json={"input": user_input},
            timeout=10
        )
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"❌ Failed to call webhook: {e}")
        return

    # 3) Print the response
    print("✅ Response from n8n:")
    # If n8n returns JSON, print it nicely
    content_type = response.headers.get("Content-Type", "")
    if "application/json" in content_type:
        try:
            print(response.json())
        except ValueError:
            print(response.text)
    else:
        print(response.text)

if __name__ == "__main__":
    main()
