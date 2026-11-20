# Prototypes

Throwaway spikes that exist to settle design questions in [PLAN.md](../PLAN.md) with measurements rather than assertions. None of this is the implementation; the SQL in `postgres-claim/` graduates, everything else gets deleted once the real test suites exist.

| Spike | Question it answers | Verdict |
|---|---|---|
| [`postgres-claim/`](./postgres-claim/) | Can the conditional claim oversell, and what can one serial worker sustain? | **Adopted.** No oversell under 20× oversubscription; ~23 650 claims/s batched |
| [`redis-grant/`](./redis-grant/) | Would a synchronous Redis Lua grant be better? | **Rejected.** ~9× faster, but can tell a user "confirmed" before the order is durable |

The two together are the evidence behind the central decision in plan §3: serialize in the queue and claim transactionally, accepting an asynchronous result in exchange for never giving an answer the durable state cannot back.
