# Telemetry

The playground telemetry layer is centralized in `web/telemetry.mjs`. It is
disabled unless runtime configuration is present and the current host is in the
allowed host list. The checked-in configuration enables Google Analytics only
on `andrewh.github.io`.

## Configuration

`web/index.html` sets:

```js
window.motelTelemetryConfig = {
  measurementID: "G-B2GVLBQD3G",
};
```

Optional fields:

- `allowedHosts`: hostnames where telemetry may run. Defaults to
  `["andrewh.github.io"]`.
- `otelEndpoint`: an OTLP HTTP traces endpoint. When omitted, OpenTelemetry
  helpers are no-ops.
- `otelModuleBaseURL`: ESM CDN base for OpenTelemetry Web SDK modules.
- `otelAPIPackageVersion`: OpenTelemetry API package version to load.
- `otelPackageVersion`: OpenTelemetry package version to load.

## Events

Google Analytics uses manual page views with sanitized URLs. `page_location`
and `page_path` include only origin and pathname, never `location.hash`.

| Event | Parameters |
| --- | --- |
| `page_view` | `page_title`, `page_location`, `page_path` |
| `wasm_load_started` | none |
| `wasm_load_completed` | `duration_ms` |
| `wasm_load_failed` | `duration_ms`, `error_category` |
| `run_started` | `duration_seconds`, `slow_threshold_ms`, `signals` |
| `run_completed` | run settings, `duration_ms`, `traces`, `spans`, `errors` |
| `run_failed` | run settings, `duration_ms`, `error_category` |
| `result_tab_changed` | `view` |
| `topology_loaded` | `size_bucket` |
| `topology_saved` | none |
| `topology_generated` | `max_nodes` |
| `share_link_created` | none |
| `share_link_rejected` | `reason` |
| `trace_file_loaded` | `format`, `size_bucket` |
| `trace_import_started` | `format`, `size_bucket` |
| `trace_import_completed` | `format`, `size_bucket`, `traces`, `spans` |
| `trace_import_failed` | `format`, `size_bucket`, `error_category` |
| `result_exported` | `traces`, `spans`, `errors` |
| `result_imported` | `size_bucket`, `traces`, `spans`, `errors` |
| `result_import_failed` | `size_bucket`, `error_category` |
| `report_printed` | `traces`, `spans`, `errors` |
| `otel_init_failed` | `error_category` |

## OpenTelemetry Spans

When `otelEndpoint` is configured, `web/telemetry.mjs` loads the OpenTelemetry
Web SDK as ESM and exports spans through OTLP HTTP:

| Span | Purpose |
| --- | --- |
| `motel.app.startup` | initial browser startup and WASM readiness |
| `motel.wasm.load` | WASM fetch, instantiate, and Go runtime startup |
| `motel.topology.run` | background topology execution |
| `motel.preview.render` | preview SVG generation |
| `motel.result.render` | result pane updates after a run or import |
| `motel.service_map.render` | service map render/update work |
| `motel.trace_import` | trace import and topology inference |

## Privacy Boundary

Telemetry must not emit topology YAML, raw JSON output, imported trace payloads,
generated result payloads, filenames, share URLs, URL hashes, or other
user-authored content. Use aggregate counts, coarse size buckets, settings, and
error categories only.
