// The same five-service sample topology the web playground opens with.
let sampleTopology = """
# Five-service topology demonstrating motel capabilities
version: 1

services:
  gateway:
    resource_attributes:
      deployment.environment: production
      service.namespace: demo
    metrics:
      - name: gateway.request.duration
        type: histogram
        unit: ms
      - name: gateway.error.count
        type: counter
        errors_only: true
    logs:
      - severity: INFO
        body: "gateway handled {operation.name}"
    operations:
      GET /users:
        duration: 30ms +/- 10ms
        error_rate: 0.1%
        attributes:
          http.request.method:
            value: GET
          http.route:
            value: "/api/v1/users"
        calls:
          - user-service.list
      POST /orders:
        duration: 80ms +/- 20ms
        error_rate: 0.5%
        calls:
          - order-service.create

  user-service:
    operations:
      list:
        duration: 20ms +/- 5ms
        error_rate: 0.1%
        calls:
          - postgres.query

  order-service:
    operations:
      create:
        duration: 50ms +/- 15ms
        error_rate: 0.5%
        call_style: parallel
        calls:
          - postgres.query
          - redis.get

  postgres:
    operations:
      query:
        duration: 5ms +/- 2ms
        error_rate: 0.01%

  redis:
    operations:
      get:
        duration: 1ms +/- 0.5ms
        error_rate: 0.001%

traffic:
  rate: 12/s

scenarios:
  - name: database degradation
    at: +200ms
    duration: 600ms
    override:
      postgres.query:
        duration: 500ms +/- 100ms
        error_rate: 15%
"""
