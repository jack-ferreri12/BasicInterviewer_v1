import requests

# TODO: replace this with your actual n8n Webhook URL
WEBHOOK_URL = "https://hudmarr.app.n8n.cloud/webhook/fb613c07-aa88-4fbd-a3c9-ba4cdf7387a9"

# Select which test scenario to run (change this value to "1", "2", "3", "4", or "5")
TEST_ID = "2"

# Shared list of questions for all scenarios
QUESTIONS = [
    "Tell me about your last project.",
    "How did you approach the main challenge?",
    "Can you walk me through your reasoning on the algorithm?",
    "Where do you see yourself in five years?"
]

# Predefined test cases with richer back-and-forth
TEST_CASES = {
    "1": {
        "questions": QUESTIONS,
        "current_question": 1,
        "transcript": [
            {"speaker": "AI", "text": QUESTIONS[0]},
            {"speaker": "Human", "text": (
                "Over the past year, I led the development of an end-to-end healthcare monitoring platform used by over ten hospitals. "
                "I spearheaded the design of the microservices architecture, implemented RESTful APIs with Flask, and set up real-time data streaming using Kafka. "
                "I collaborated with data scientists to integrate predictive analytics for early warning alerts and optimized system performance to handle millions of events per day.")},
            {"speaker": "AI", "text": "That's impressive—could you elaborate on how you managed the database schema and handled scaling challenges?"},
            {"speaker": "Human", "text": (
                "Certainly. We chose a hybrid approach with PostgreSQL for transactional data and a time-series database (InfluxDB) for patient metrics. "
                "I normalized core tables and partitioned large datasets by date to improve query performance. "
                "To handle spikes, I configured Kafka consumers with auto-scaling groups and used connection pooling libraries to optimize database throughput.")}
        ]
    },
    "2": {
        "questions": QUESTIONS,
        "current_question": 2,
        "transcript": [
            {"speaker": "AI", "text": QUESTIONS[1]},
            {"speaker": "Human", "text": (
                "When we faced inconsistent load patterns, I first profiled the application under simulated traffic. "
                "I implemented circuit breakers with Hystrix to isolate failures and introduced Redis caching for frequently accessed endpoints. "
                "Then, I refactored the core service to use asynchronous processing with Celery, which reduced request latency by 40% under peak conditions.")},
            {"speaker": "AI", "text": "Thanks for that—can you walk me through the debugging process you used when that solution didn't work initially?"},
            {"speaker": "Human", "text": (
                "Absolutely. I started by capturing detailed logs with correlation IDs, then used distributed tracing via Jaeger to identify bottlenecks. "
                "I discovered a memory leak in a third-party library, patched it, and wrote unit tests to catch similar issues in the future.")}
        ]
    },
    "3": {
        "questions": QUESTIONS,
        "current_question": 3,
        "transcript": [
            {"speaker": "AI", "text": QUESTIONS[2]},
            {"speaker": "Human", "text": (
                "I approached the algorithm by first defining the problem space as a weighted graph. "
                "I used Dijkstra's algorithm for shortest-path calculations and optimized it with a binary heap to achieve O((V+E) log V) complexity. "
                "I also implemented caching of intermediate results to speed up repeated queries.")},
            {"speaker": "AI", "text": "Understood—could you clarify why you chose a heuristic over an exhaustive search in that context?"},
            {"speaker": "Human", "text": (
                "Sure. An exhaustive search would have been O(n!), which was infeasible for large datasets. "
                "The heuristic provided near-optimal results in linear time for our typical graph sizes, and I validated accuracy by benchmarking against smaller inputs.")}
        ]
    },
    "4": {
        "questions": QUESTIONS,
        "current_question": 4,
        "transcript": [
            {"speaker": "AI", "text": QUESTIONS[3]},
            {"speaker": "Human", "text": (
                "In five years, I see myself in a leadership role, mentoring junior engineers and driving architectural decisions. "
                "I plan to deepen my expertise in cloud-native technologies and contribute to open-source projects. "
                "I'm also interested in formal project management training to better align teams with business goals.")},
            {"speaker": "AI", "text": "Great aspirations—how do you plan to develop the leadership skills needed to get there?"},
            {"speaker": "Human", "text": (
                "I intend to enroll in an executive education program focused on leadership, seek mentorship within my organization, "
                "and take on stretch assignments that involve cross-functional coordination and decision-making.")}
        ]
    },
    "5": {
        "questions": QUESTIONS,
        "current_question": 2,
        "transcript": [
            {"speaker": "AI", "text": QUESTIONS[1]},
            {"speaker": "Human", "text": (
                "When tackling our main challenge of real-time data ingestion, I first prototyped a solution using AWS Kinesis. "
                "After measuring throughput limitations, I switched to Kafka for its superior scaling capabilities. "
                "I wrote custom producers in Go to minimize client-side latency and tuned broker configurations for optimal partitioning.")},
            {"speaker": "AI", "text": "Interesting approach—what metrics did you track to ensure your ingestion pipeline met SLAs?"},
            {"speaker": "Human", "text": (
                "I monitored end-to-end latency with Prometheus, set up alerts for 95th percentile response times, "
                "and tracked consumer lag to ensure data freshness.")}
        ]
    }
}

def main():
    payload = TEST_CASES.get(TEST_ID)
    if payload is None:
        print(f"❌ Invalid TEST_ID '{TEST_ID}'. Choose from {list(TEST_CASES.keys())}.")
        return

    print(f"▶️ Running test scenario {TEST_ID}")
    print("Payload to send:", payload)

    try:
        response = requests.post(
            WEBHOOK_URL,
            json=payload,
            timeout=10
        )
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"❌ Failed to call webhook: {e}")
        return

    print("✅ Response from n8n:")
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

