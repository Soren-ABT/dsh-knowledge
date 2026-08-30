# Quartz API Tracing Convention

Every cross-service request carries the `X-Quartz-Trace` header. The edge service creates a 24-character lowercase hexadecimal identifier, and downstream services preserve it unchanged.
