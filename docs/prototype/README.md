# Prototypes

Throwaway spikes that exist to settle design questions in [PLAN.md](../PLAN.md) with measurements rather than assertions. None of this is the implementation; the SQL in `postgres-claim/` graduates, everything else gets deleted once the real test suites exist.

| Spike | Question it answers | Verdict |
|---|---|---|
| [`postgres-claim/`](./postgres-claim/) | Can the conditional claim oversell, is a redelivered batch safe, and what can one serial worker sustain? | **Adopted.** No oversell under 20× oversubscription; redelivery is a no-op; ~37–41k claims/s batched |
| [`postgres-pool/`](./postgres-pool/) | Does pre-warming stock as claimable rows beat the counter row? | **Open.** 61k claims/s batched+parallel, but the naive form oversells 9.5× and it may remove the need for the queue |
| [`redis-grant/`](./redis-grant/) | Would a synchronous Redis Lua grant be better? | **Rejected.** ~9× faster, but can tell a user "confirmed" before the order is durable |

The two together are the evidence behind the central decision in plan §3: serialize in the queue and claim transactionally, accepting an asynchronous result in exchange for never giving an answer the durable state cannot back.
