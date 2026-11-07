# Changelog

## 0.1.0

- First version. Mock replays the 17 use cases measured on 2026-11-07 (5 log sinks); Real sends them to a configured gateway over MCP streamable HTTP and reads the log back from a search endpoint or from pasted lines.
- Scorer: a pure function that scores user, agent, tool and decision from log lines (logrus text and JSON records); pinned against the capture with five documented differences.
- Pages: Run, Trace, Scorecard (Markdown export), Where it's logged, Diagram (one per flow, diagram-studio/1 data), Talk track. Presenter mode, theme picker, Reset.
