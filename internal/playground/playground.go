package playground

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"math"
	"math/rand/v2"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/andrewh/motel/pkg/synth"
	"github.com/andrewh/motel/pkg/synth/traceimport"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/metric"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
	"go.opentelemetry.io/otel/trace"
)

const (
	maxDuration         = 10 * time.Second
	defaultDuration     = time.Second
	maxTraces           = 200
	maxSpansPerTrace    = 500
	maxCapturedSpans    = 1000
	maxCapturedMetrics  = 500
	maxCapturedLogs     = 500
	defaultPreviewRange = 5 * time.Minute
	traceFormatAuto     = "auto"
	traceFormatOTLP     = "otlp"
	traceFormatStdout   = "stdouttrace"
)

type Diagnostic struct {
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type ValidationResult struct {
	OK          bool                `json:"ok"`
	Diagnostics []Diagnostic        `json:"diagnostics"`
	Topology    *TopologySummary    `json:"topology,omitempty"`
	Checks      []synth.CheckResult `json:"checks,omitempty"`
}

type TraceImportResult struct {
	OK          bool              `json:"ok"`
	Topology    string            `json:"topology,omitempty"`
	Diagnostics []Diagnostic      `json:"diagnostics"`
	Stats       *TraceImportStats `json:"stats,omitempty"`
}

type TraceImportStats struct {
	Format string `json:"format"`
	Traces int    `json:"traces"`
	Spans  int    `json:"spans"`
}

type TopologySummary struct {
	Services   []ServiceSummary `json:"services"`
	Roots      []string         `json:"roots"`
	Operations int              `json:"operations"`
	Edges      int              `json:"edges"`
	Scenarios  int              `json:"scenarios"`
	Graph      GraphData        `json:"graph"`
}

type ServiceSummary struct {
	Name       string             `json:"name"`
	Operations []OperationSummary `json:"operations"`
}

type OperationSummary struct {
	Ref       string   `json:"ref"`
	Duration  string   `json:"duration"`
	ErrorRate string   `json:"error_rate,omitempty"`
	Calls     []string `json:"calls,omitempty"`
}

type GraphData struct {
	Nodes    []GraphNode `json:"nodes"`
	Edges    []GraphEdge `json:"edges"`
	GridCols int         `json:"gridCols"`
	GridRows int         `json:"gridRows"`
}

type GraphNode struct {
	ID         string   `json:"id"`
	Operations []string `json:"operations"`
	IsRoot     bool     `json:"isRoot"`
	Col        int      `json:"col"`
	Row        int      `json:"row"`
}

type GraphEdge struct {
	Source string      `json:"source"`
	Target string      `json:"target"`
	Weight float64     `json:"weight"`
	Async  bool        `json:"async"`
	Calls  []GraphCall `json:"calls"`
}

type GraphCall struct {
	From        string  `json:"from"`
	To          string  `json:"to"`
	Probability float64 `json:"probability"`
	Count       int     `json:"count"`
	Async       bool    `json:"async"`
}

type SpanRecord struct {
	TraceID         string            `json:"trace_id"`
	SpanID          string            `json:"span_id"`
	Service         string            `json:"service"`
	Operation       string            `json:"operation"`
	ParentService   string            `json:"parent_service,omitempty"`
	ParentOperation string            `json:"parent_operation,omitempty"`
	TimestampMs     int64             `json:"timestamp_ms"`
	DurationMs      float64           `json:"duration_ms"`
	IsError         bool              `json:"is_error"`
	Kind            string            `json:"kind"`
	Scenarios       []string          `json:"scenarios,omitempty"`
	Attributes      map[string]string `json:"attributes,omitempty"`
}

type MetricRecord struct {
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	Unit        string            `json:"unit,omitempty"`
	Service     string            `json:"service,omitempty"`
	Operation   string            `json:"operation,omitempty"`
	Value       float64           `json:"value,omitempty"`
	Count       uint64            `json:"count,omitempty"`
	Sum         float64           `json:"sum,omitempty"`
	Min         float64           `json:"min,omitempty"`
	Max         float64           `json:"max,omitempty"`
	TimestampMs int64             `json:"timestamp_ms,omitempty"`
	StartMs     int64             `json:"start_ms,omitempty"`
	Attributes  map[string]string `json:"attributes,omitempty"`
}

type LogRecord struct {
	Severity    string            `json:"severity"`
	Body        string            `json:"body"`
	Service     string            `json:"service,omitempty"`
	Operation   string            `json:"operation,omitempty"`
	TimestampMs int64             `json:"timestamp_ms,omitempty"`
	TraceID     string            `json:"trace_id,omitempty"`
	SpanID      string            `json:"span_id,omitempty"`
	Attributes  map[string]string `json:"attributes,omitempty"`
}

type RunResult struct {
	OK       bool             `json:"ok"`
	Stats    *synth.Stats     `json:"stats,omitempty"`
	Topology *TopologySummary `json:"topology,omitempty"`
	Spans    []SpanRecord     `json:"spans,omitempty"`
	Metrics  []MetricRecord   `json:"metrics,omitempty"`
	Logs     []LogRecord      `json:"logs,omitempty"`
	Errors   []Diagnostic     `json:"errors,omitempty"`
	Signals  RunSignals       `json:"signals"`
	Limits   RunLimits        `json:"limits"`
}

type RunSignals struct {
	Traces  bool `json:"traces"`
	Metrics bool `json:"metrics"`
	Logs    bool `json:"logs"`
}

type RunLimits struct {
	DurationSeconds  float64 `json:"duration_seconds"`
	MaxTraces        int     `json:"max_traces"`
	MaxSpansPerTrace int     `json:"max_spans_per_trace"`
	CapturedSpans    int     `json:"captured_spans"`
	CapturedMetrics  int     `json:"captured_metrics"`
	CapturedLogs     int     `json:"captured_logs"`
}

func DefaultRunSignals() RunSignals {
	return RunSignals{
		Traces:  true,
		Metrics: true,
		Logs:    true,
	}
}

type captureObserver struct {
	mu    sync.Mutex
	spans []SpanRecord
}

type captureLogExporter struct {
	mu      sync.Mutex
	records []sdklog.Record
}

type metricCapture struct {
	Meters    map[string]metric.Meter
	readers   []*sdkmetric.ManualReader
	providers []*sdkmetric.MeterProvider
}

type logCapture struct {
	Loggers   map[string]log.Logger
	exporter  *captureLogExporter
	providers []*sdklog.LoggerProvider
}

func (e *captureLogExporter) Export(_ context.Context, records []sdklog.Record) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, record := range records {
		if len(e.records) >= maxCapturedLogs {
			return nil
		}
		e.records = append(e.records, record.Clone())
	}
	return nil
}

func (e *captureLogExporter) Shutdown(context.Context) error   { return nil }
func (e *captureLogExporter) ForceFlush(context.Context) error { return nil }

func (e *captureLogExporter) Records() []sdklog.Record {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]sdklog.Record(nil), e.records...)
}

func newMetricCapture(topo *synth.Topology) *metricCapture {
	capture := &metricCapture{
		Meters: make(map[string]metric.Meter, len(topo.Services)),
	}
	for _, serviceName := range sortedServiceNames(topo) {
		reader := sdkmetric.NewManualReader()
		res := resource.NewSchemaless(semconv.ServiceName(serviceName))
		provider := sdkmetric.NewMeterProvider(
			sdkmetric.WithReader(reader),
			sdkmetric.WithResource(res),
		)
		capture.readers = append(capture.readers, reader)
		capture.providers = append(capture.providers, provider)
		capture.Meters[serviceName] = provider.Meter("motel")
	}
	return capture
}

func newLogCapture(topo *synth.Topology) *logCapture {
	capture := &logCapture{
		Loggers:  make(map[string]log.Logger, len(topo.Services)),
		exporter: &captureLogExporter{},
	}
	for _, serviceName := range sortedServiceNames(topo) {
		res := resource.NewSchemaless(semconv.ServiceName(serviceName))
		provider := sdklog.NewLoggerProvider(
			sdklog.WithProcessor(sdklog.NewSimpleProcessor(capture.exporter)),
			sdklog.WithResource(res),
		)
		capture.providers = append(capture.providers, provider)
		capture.Loggers[serviceName] = provider.Logger("motel")
	}
	return capture
}

func (c *logCapture) Records() []LogRecord {
	for _, provider := range c.providers {
		_ = provider.ForceFlush(context.Background())
	}
	return logRecords(c.exporter.Records())
}

func (c *logCapture) Shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, provider := range c.providers {
		_ = provider.Shutdown(ctx)
	}
}

func (c *metricCapture) Records() []MetricRecord {
	var out []MetricRecord
	for _, reader := range c.readers {
		if len(out) >= maxCapturedMetrics {
			return out
		}
		var rm metricdata.ResourceMetrics
		if err := reader.Collect(context.Background(), &rm); err != nil {
			continue
		}
		out = append(out, metricRecords(rm, maxCapturedMetrics-len(out))...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TimestampMs != out[j].TimestampMs {
			return out[i].TimestampMs < out[j].TimestampMs
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (c *metricCapture) Shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, provider := range c.providers {
		_ = provider.Shutdown(ctx)
	}
}

func (o *captureObserver) Observe(info synth.SpanInfo) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.spans) >= maxCapturedSpans {
		return
	}

	o.spans = append(o.spans, SpanRecord{
		TraceID:         info.SpanContext.TraceID().String(),
		SpanID:          info.SpanContext.SpanID().String(),
		Service:         info.Service,
		Operation:       info.Operation,
		ParentService:   info.ParentService,
		ParentOperation: info.ParentOperation,
		TimestampMs:     info.Timestamp.UnixMilli(),
		DurationMs:      float64(info.Duration.Microseconds()) / 1000,
		IsError:         info.IsError,
		Kind:            spanKind(info.Kind),
		Scenarios:       append([]string(nil), info.Scenarios...),
		Attributes:      attributes(info.Attrs),
	})
}

func (o *captureObserver) Records() []SpanRecord {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]SpanRecord(nil), o.spans...)
}

func Validate(source string) ValidationResult {
	cfg, topo, scenarios, err := load(source)
	if err != nil {
		return ValidationResult{
			OK: false,
			Diagnostics: []Diagnostic{{
				Severity: "error",
				Message:  err.Error(),
			}},
		}
	}

	checks := synth.Check(topo, synth.CheckOptions{
		MaxDepth:         12,
		MaxFanOut:        12,
		MaxSpans:         maxSpansPerTrace,
		MaxSpansPerTrace: maxSpansPerTrace,
		Samples:          50,
		Seed:             1,
		Scenarios:        scenarios,
	})

	diagnostics := []Diagnostic{{
		Severity: "success",
		Message:  "Topology is valid.",
	}}
	for _, check := range checks {
		if !check.Pass {
			diagnostics = append(diagnostics, Diagnostic{
				Severity: "warning",
				Message:  fmt.Sprintf("%s exceeds limit: %d > %d", check.Name, check.Actual, check.Limit),
			})
		}
	}

	return ValidationResult{
		OK:          true,
		Diagnostics: diagnostics,
		Topology:    summariseConfig(cfg, topo),
		Checks:      checks,
	}
}

func ImportTraces(source string, format string) TraceImportResult {
	traceFormat, ok := parseTraceImportFormat(format)
	if !ok {
		return traceImportError(fmt.Errorf("unknown trace format %q", format))
	}

	var warnings bytes.Buffer
	spans, err := traceimport.ParseSpans(strings.NewReader(source), traceFormat)
	if err != nil {
		return traceImportError(err)
	}

	trees := traceimport.BuildTrees(spans, &warnings)
	traceCount := len(trees)
	if traceCount == 1 {
		_, _ = fmt.Fprintln(&warnings, "warning: only 1 trace available; duration distributions will be exact values. Use more traces for statistical accuracy.")
	}

	collector := traceimport.NewStatsCollector()
	collector.CollectFromTrees(trees)

	yamlBytes, err := traceimport.MarshalConfig(
		collector,
		importServiceAttributes(spans),
		traceCount,
		len(spans),
		importWindowSeconds(trees),
	)
	if err != nil {
		return traceImportError(err)
	}

	cfg, err := synth.ParseConfig(yamlBytes)
	if err != nil {
		return traceImportError(fmt.Errorf("validating inferred topology: %w", err))
	}
	if err := synth.ValidateConfig(cfg); err != nil {
		return traceImportError(fmt.Errorf("validating inferred topology: %w", err))
	}

	diagnostics := []Diagnostic{{
		Severity: "success",
		Message:  fmt.Sprintf("Imported %d traces and %d spans.", traceCount, len(spans)),
	}}
	for _, warning := range traceImportWarnings(warnings.String()) {
		diagnostics = append(diagnostics, Diagnostic{
			Severity: "warning",
			Message:  warning,
		})
	}

	return TraceImportResult{
		OK:          true,
		Topology:    string(yamlBytes),
		Diagnostics: diagnostics,
		Stats: &TraceImportStats{
			Format: string(traceFormat),
			Traces: traceCount,
			Spans:  len(spans),
		},
	}
}

func Run(source string, duration time.Duration, seed uint64, signals RunSignals, slowThresholds ...time.Duration) RunResult {
	if duration <= 0 {
		duration = defaultDuration
	}
	if duration > maxDuration {
		duration = maxDuration
	}
	slowThreshold := time.Duration(0)
	if len(slowThresholds) > 0 {
		slowThreshold = slowThresholds[0]
	}

	cfg, topo, scenarios, err := load(source)
	if err != nil {
		return RunResult{
			OK:      false,
			Errors:  []Diagnostic{{Severity: "error", Message: err.Error()}},
			Signals: signals,
			Limits:  limits(duration, 0, 0, 0),
		}
	}

	traffic, err := synth.NewTrafficPattern(cfg.Traffic)
	if err != nil {
		return RunResult{
			OK:      false,
			Errors:  []Diagnostic{{Severity: "error", Message: err.Error()}},
			Signals: signals,
			Limits:  limits(duration, 0, 0, 0),
		}
	}

	var observer *captureObserver
	observers := make([]synth.SpanObserver, 0, 3)
	if signals.Traces {
		observer = &captureObserver{}
		observers = append(observers, observer)
	}

	var metricCapture *metricCapture
	var stopMetrics func()
	if signals.Metrics {
		metricCapture = newMetricCapture(topo)
		defer metricCapture.Shutdown()
		metricObserver, err := synth.NewMetricObserver(metricCapture.Meters, topo, rand.New(rand.NewPCG(seed^0xa0761d6478bd642f, seed^0xe7037ed1a0b428db)))
		if err != nil {
			return RunResult{
				OK:       false,
				Topology: summariseConfig(cfg, topo),
				Errors:   []Diagnostic{{Severity: "error", Message: err.Error()}},
				Signals:  signals,
				Limits:   limits(duration, 0, 0, 0),
			}
		}
		stopMetrics = metricObserver.Start()
		observers = append(observers, metricObserver)
		defer func() {
			if stopMetrics != nil {
				stopMetrics()
			}
		}()
	}

	var logCapture *logCapture
	if signals.Logs {
		logCapture = newLogCapture(topo)
		defer logCapture.Shutdown()
		logObserver, err := synth.NewLogObserver(logCapture.Loggers, topo, slowThreshold, rand.New(rand.NewPCG(seed^0x8ebc6af09c88c6e3, seed^0x589965cc75374cc3)))
		if err != nil {
			return RunResult{
				OK:       false,
				Topology: summariseConfig(cfg, topo),
				Errors:   []Diagnostic{{Severity: "error", Message: err.Error()}},
				Signals:  signals,
				Limits:   limits(duration, 0, 0, 0),
			}
		}
		observers = append(observers, logObserver)
	}

	ctx, cancel := context.WithTimeout(context.Background(), duration+2*time.Second)
	defer cancel()
	tracerProvider := sdktrace.NewTracerProvider()
	defer func() { _ = tracerProvider.Shutdown(context.Background()) }()

	rng := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	engine := synth.Engine{
		Topology:         topo,
		Traffic:          traffic,
		Scenarios:        scenarios,
		Tracers:          func(serviceName string) trace.Tracer { return tracerProvider.Tracer(serviceName) },
		Rng:              rng,
		Duration:         duration,
		Observers:        observers,
		MaxSpansPerTrace: maxSpansPerTrace,
		MaxTraces:        maxTraces,
		State:            synth.NewSimulationState(topo),
		LabelScenarios:   true,
	}

	stats, err := engine.Run(ctx)
	if err != nil {
		return RunResult{
			OK:       false,
			Topology: summariseConfig(cfg, topo),
			Errors:   []Diagnostic{{Severity: "error", Message: err.Error()}},
			Signals:  signals,
			Limits:   limits(duration, 0, 0, 0),
		}
	}

	var spans []SpanRecord
	if observer != nil {
		spans = observer.Records()
	}
	var metrics []MetricRecord
	if metricCapture != nil {
		stopMetrics()
		stopMetrics = nil
		metrics = metricCapture.Records()
	}
	var logs []LogRecord
	if logCapture != nil {
		logs = logCapture.Records()
	}
	return RunResult{
		OK:       true,
		Stats:    stats,
		Topology: summariseConfig(cfg, topo),
		Spans:    spans,
		Metrics:  metrics,
		Logs:     logs,
		Signals:  signals,
		Limits:   limits(duration, len(spans), len(metrics), len(logs)),
	}
}

func parseTraceImportFormat(value string) (traceimport.Format, bool) {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "", traceFormatAuto:
		return traceimport.FormatAuto, true
	case traceFormatOTLP:
		return traceimport.FormatOTLP, true
	case traceFormatStdout:
		return traceimport.FormatStdouttrace, true
	default:
		return "", false
	}
}

func traceImportError(err error) TraceImportResult {
	return TraceImportResult{
		OK: false,
		Diagnostics: []Diagnostic{{
			Severity: "error",
			Message:  err.Error(),
		}},
	}
}

func importServiceAttributes(spans []traceimport.Span) map[string]map[string]string {
	type attrAccum struct {
		value    string
		count    int
		constant bool
	}

	serviceAttrs := make(map[string]map[string]*attrAccum)
	serviceCounts := make(map[string]int)
	for _, span := range spans {
		serviceCounts[span.Service]++
		attrs, ok := serviceAttrs[span.Service]
		if !ok {
			attrs = make(map[string]*attrAccum)
			serviceAttrs[span.Service] = attrs
		}
		for key, value := range span.Attributes {
			attr, ok := attrs[key]
			if !ok {
				attrs[key] = &attrAccum{value: value, count: 1, constant: true}
				continue
			}
			attr.count++
			if attr.value != value {
				attr.constant = false
			}
		}
	}

	result := make(map[string]map[string]string)
	for serviceName, attrs := range serviceAttrs {
		values := make(map[string]string)
		for key, attr := range attrs {
			if attr.constant && attr.count == serviceCounts[serviceName] {
				values[key] = attr.value
			}
		}
		if len(values) > 0 {
			result[serviceName] = values
		}
	}
	return result
}

func importWindowSeconds(trees []*traceimport.TraceTree) float64 {
	rootTimes := make([]time.Time, 0, len(trees))
	for _, tree := range trees {
		for _, root := range tree.Roots {
			rootTimes = append(rootTimes, root.Span.StartTime)
		}
	}
	if len(rootTimes) < 2 {
		return 0
	}
	sort.Slice(rootTimes, func(i, j int) bool {
		return rootTimes[i].Before(rootTimes[j])
	})
	return rootTimes[len(rootTimes)-1].Sub(rootTimes[0]).Seconds()
}

func traceImportWarnings(output string) []string {
	var warnings []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			warnings = append(warnings, line)
		}
	}
	return warnings
}

func Preview(source string, duration time.Duration) (string, error) {
	cfg, topo, scenarios, err := load(source)
	if err != nil {
		return "", err
	}
	traffic, err := synth.NewTrafficPattern(cfg.Traffic)
	if err != nil {
		return "", err
	}
	if duration <= 0 {
		duration = inferPreviewDuration(scenarios)
	}
	if duration > 30*time.Minute {
		duration = 30 * time.Minute
	}
	return renderPreviewSVG(cfg.Traffic, traffic, scenarios, duration, summariseConfig(cfg, topo), topo), nil
}

func load(source string) (*synth.Config, *synth.Topology, []synth.Scenario, error) {
	cfg, err := synth.ParseConfig([]byte(source))
	if err != nil {
		return nil, nil, nil, err
	}
	if err := synth.ValidateConfig(cfg); err != nil {
		return nil, nil, nil, err
	}
	topo, err := synth.BuildTopology(cfg)
	if err != nil {
		return nil, nil, nil, err
	}
	scenarios, err := synth.BuildScenarios(cfg.Scenarios, topo)
	if err != nil {
		return nil, nil, nil, err
	}
	return cfg, topo, scenarios, nil
}

func summariseConfig(cfg *synth.Config, topo *synth.Topology) *TopologySummary {
	summary := &TopologySummary{
		Scenarios: len(cfg.Scenarios),
		Graph:     buildGraphData(topo),
	}
	rootSet := make(map[string]bool, len(topo.Roots))
	for _, root := range topo.Roots {
		rootSet[root.Ref] = true
		summary.Roots = append(summary.Roots, root.Ref)
	}
	sort.Strings(summary.Roots)

	serviceNames := make([]string, 0, len(cfg.Services))
	serviceByName := make(map[string]synth.ServiceConfig, len(cfg.Services))
	for _, svc := range cfg.Services {
		serviceNames = append(serviceNames, svc.Name)
		serviceByName[svc.Name] = svc
	}
	sort.Strings(serviceNames)

	for _, serviceName := range serviceNames {
		svc := serviceByName[serviceName]
		item := ServiceSummary{Name: svc.Name}
		ops := append([]synth.OperationConfig(nil), svc.Operations...)
		sort.Slice(ops, func(i, j int) bool { return ops[i].Name < ops[j].Name })
		for _, op := range ops {
			ref := svc.Name + "." + op.Name
			calls := make([]string, 0, len(op.Calls))
			for _, call := range op.Calls {
				calls = append(calls, call.Target)
			}
			sort.Strings(calls)
			summary.Operations++
			summary.Edges += len(calls)
			item.Operations = append(item.Operations, OperationSummary{
				Ref:       ref,
				Duration:  op.Duration,
				ErrorRate: op.ErrorRate,
				Calls:     calls,
			})
		}
		summary.Services = append(summary.Services, item)
	}

	return summary
}

func buildGraphData(topo *synth.Topology) GraphData {
	rootServices := make(map[string]bool, len(topo.Roots))
	for _, op := range topo.Roots {
		rootServices[op.Service.Name] = true
	}

	var data GraphData
	edgeMap := make(map[string]*GraphEdge)
	serviceNames := sortedServiceNames(topo)
	for _, serviceName := range serviceNames {
		svc := topo.Services[serviceName]
		operationNames := sortedOperationNames(svc)
		data.Nodes = append(data.Nodes, GraphNode{
			ID:         serviceName,
			Operations: operationNames,
			IsRoot:     rootServices[serviceName],
		})
		for _, operationName := range operationNames {
			op := svc.Operations[operationName]
			for _, call := range op.Calls {
				target := call.Operation.Service.Name
				key := serviceName + "\x00" + target
				edge, ok := edgeMap[key]
				if !ok {
					edge = &GraphEdge{Source: serviceName, Target: target, Async: true}
					edgeMap[key] = edge
				}
				count := call.Count
				if count < 1 {
					count = 1
				}
				probability := call.Probability
				if probability <= 0 {
					probability = 1
				}
				edge.Weight += probability * float64(count)
				edge.Async = edge.Async && call.Async
				edge.Calls = append(edge.Calls, GraphCall{
					From:        operationName,
					To:          call.Operation.Name,
					Probability: probability,
					Count:       count,
					Async:       call.Async,
				})
			}
		}
	}

	edgeKeys := make([]string, 0, len(edgeMap))
	for key := range edgeMap {
		edgeKeys = append(edgeKeys, key)
	}
	sort.Strings(edgeKeys)
	for _, key := range edgeKeys {
		data.Edges = append(data.Edges, *edgeMap[key])
	}

	layoutGraph(&data, serviceLayers(topo))
	return data
}

func sortedServiceNames(topo *synth.Topology) []string {
	names := make([]string, 0, len(topo.Services))
	for name := range topo.Services {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func sortedOperationNames(svc *synth.Service) []string {
	names := make([]string, 0, len(svc.Operations))
	for name := range svc.Operations {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func serviceLayers(topo *synth.Topology) map[string]int {
	opDepth := make(map[*synth.Operation]int)
	var visit func(op *synth.Operation, depth int)
	visit = func(op *synth.Operation, depth int) {
		if existing, seen := opDepth[op]; seen && existing >= depth {
			return
		}
		opDepth[op] = depth
		for _, call := range op.Calls {
			visit(call.Operation, depth+1)
		}
	}
	for _, root := range topo.Roots {
		visit(root, 0)
	}

	layers := make(map[string]int, len(topo.Services))
	for op, depth := range opDepth {
		serviceName := op.Service.Name
		if existing, seen := layers[serviceName]; !seen || depth > existing {
			layers[serviceName] = depth
		}
	}
	for serviceName := range topo.Services {
		if _, seen := layers[serviceName]; !seen {
			layers[serviceName] = 0
		}
	}
	return layers
}

func layoutGraph(data *GraphData, layers map[string]int) {
	maxLayer := 0
	for _, layer := range layers {
		if layer > maxLayer {
			maxLayer = layer
		}
	}

	columns := make([][]int, maxLayer+1)
	for i, node := range data.Nodes {
		columns[layers[node.ID]] = append(columns[layers[node.ID]], i)
	}

	indexByID := make(map[string]int, len(data.Nodes))
	for i, node := range data.Nodes {
		indexByID[node.ID] = i
	}
	neighbours := make(map[int][]int, len(data.Nodes))
	for _, edge := range data.Edges {
		source := indexByID[edge.Source]
		target := indexByID[edge.Target]
		if source == target {
			continue
		}
		neighbours[source] = append(neighbours[source], target)
		neighbours[target] = append(neighbours[target], source)
	}

	rank := make([]float64, len(data.Nodes))
	setRanks := func(column []int) {
		if len(column) == 0 {
			return
		}
		for position, i := range column {
			rank[i] = (float64(position) + 0.5) / float64(len(column))
		}
	}
	for _, column := range columns {
		setRanks(column)
	}

	barycenter := func(i int) float64 {
		ns := neighbours[i]
		if len(ns) == 0 {
			return rank[i]
		}
		sum := 0.0
		for _, n := range ns {
			sum += rank[n]
		}
		return sum / float64(len(ns))
	}

	for range 4 {
		for _, column := range columns {
			sort.SliceStable(column, func(i, j int) bool {
				left := column[i]
				right := column[j]
				leftCenter := barycenter(left)
				rightCenter := barycenter(right)
				if leftCenter == rightCenter {
					return data.Nodes[left].ID < data.Nodes[right].ID
				}
				return leftCenter < rightCenter
			})
			setRanks(column)
		}
	}

	maxRows := 0
	for _, column := range columns {
		if len(column) > maxRows {
			maxRows = len(column)
		}
	}
	if maxRows == 0 {
		data.GridCols = 1
		data.GridRows = 1
		return
	}

	row := make([]int, len(data.Nodes))
	for _, column := range columns {
		offset := (maxRows - len(column)) / 2
		for position, i := range column {
			row[i] = offset + position
		}
	}

	medianRow := func(i int) int {
		ns := neighbours[i]
		if len(ns) == 0 {
			return row[i]
		}
		rows := make([]int, len(ns))
		for j, n := range ns {
			rows[j] = row[n]
		}
		sort.Ints(rows)
		return rows[len(rows)/2]
	}
	for range 3 {
		for _, column := range columns {
			for position, i := range column {
				lo := 0
				if position > 0 {
					lo = row[column[position-1]] + 1
				}
				hi := maxRows - (len(column) - position)
				row[i] = min(max(medianRow(i), lo), hi)
			}
		}
	}

	gridRows := 0
	for layer, column := range columns {
		for _, i := range column {
			data.Nodes[i].Col = layer
			data.Nodes[i].Row = row[i]
			if row[i]+1 > gridRows {
				gridRows = row[i] + 1
			}
		}
	}
	data.GridCols = maxLayer + 1
	data.GridRows = gridRows
}

func inferPreviewDuration(scenarios []synth.Scenario) time.Duration {
	if len(scenarios) == 0 {
		return defaultPreviewRange
	}
	var latest time.Duration
	for _, scenario := range scenarios {
		if scenario.End > latest {
			latest = scenario.End
		}
	}
	return time.Duration(float64(latest) * 1.1)
}

func limits(duration time.Duration, spans int, metrics int, logs int) RunLimits {
	return RunLimits{
		DurationSeconds:  duration.Seconds(),
		MaxTraces:        maxTraces,
		MaxSpansPerTrace: maxSpansPerTrace,
		CapturedSpans:    spans,
		CapturedMetrics:  metrics,
		CapturedLogs:     logs,
	}
}

func spanKind(kind trace.SpanKind) string {
	switch kind {
	case trace.SpanKindServer:
		return "server"
	case trace.SpanKindClient:
		return "client"
	case trace.SpanKindProducer:
		return "producer"
	case trace.SpanKindConsumer:
		return "consumer"
	default:
		return "internal"
	}
}

func attributes(attrs []attribute.KeyValue) map[string]string {
	if len(attrs) == 0 {
		return nil
	}
	out := make(map[string]string, len(attrs))
	for _, attr := range attrs {
		out[string(attr.Key)] = attr.Value.AsString()
	}
	return out
}

func metricRecords(rm metricdata.ResourceMetrics, remaining int) []MetricRecord {
	if remaining <= 0 {
		return nil
	}
	service := resourceAttribute(rm.Resource, string(semconv.ServiceNameKey))
	var out []MetricRecord
	for _, scope := range rm.ScopeMetrics {
		for _, metric := range scope.Metrics {
			out = append(out, recordsForMetric(metric, service, remaining-len(out))...)
			if len(out) >= remaining {
				return out
			}
		}
	}
	return out
}

func recordsForMetric(metric metricdata.Metrics, service string, remaining int) []MetricRecord {
	switch data := metric.Data.(type) {
	case metricdata.Gauge[int64]:
		return numberDataPointRecords(metric.Name, "gauge", metric.Unit, service, data.DataPoints, remaining)
	case metricdata.Gauge[float64]:
		return numberDataPointRecords(metric.Name, "gauge", metric.Unit, service, data.DataPoints, remaining)
	case metricdata.Sum[int64]:
		return numberDataPointRecords(metric.Name, "counter", metric.Unit, service, data.DataPoints, remaining)
	case metricdata.Sum[float64]:
		return numberDataPointRecords(metric.Name, "counter", metric.Unit, service, data.DataPoints, remaining)
	case metricdata.Histogram[int64]:
		return histogramRecords(metric.Name, metric.Unit, service, data.DataPoints, remaining)
	case metricdata.Histogram[float64]:
		return histogramRecords(metric.Name, metric.Unit, service, data.DataPoints, remaining)
	default:
		return nil
	}
}

func numberDataPointRecords[N int64 | float64](name, typ, unit, service string, dataPoints []metricdata.DataPoint[N], remaining int) []MetricRecord {
	out := make([]MetricRecord, 0, min(len(dataPoints), remaining))
	for _, point := range dataPoints {
		if len(out) >= remaining {
			break
		}
		attrs := attributeSet(point.Attributes)
		out = append(out, MetricRecord{
			Name:        name,
			Type:        typ,
			Unit:        unit,
			Service:     service,
			Operation:   popAttribute(attrs, "operation.name"),
			Value:       float64(point.Value),
			TimestampMs: unixMilli(point.Time),
			StartMs:     unixMilli(point.StartTime),
			Attributes:  emptyMapNil(attrs),
		})
	}
	return out
}

func histogramRecords[N int64 | float64](name, unit, service string, dataPoints []metricdata.HistogramDataPoint[N], remaining int) []MetricRecord {
	out := make([]MetricRecord, 0, min(len(dataPoints), remaining))
	for _, point := range dataPoints {
		if len(out) >= remaining {
			break
		}
		attrs := attributeSet(point.Attributes)
		out = append(out, MetricRecord{
			Name:        name,
			Type:        "histogram",
			Unit:        unit,
			Service:     service,
			Operation:   popAttribute(attrs, "operation.name"),
			Count:       point.Count,
			Sum:         float64(point.Sum),
			Min:         extremaValue(point.Min),
			Max:         extremaValue(point.Max),
			TimestampMs: unixMilli(point.Time),
			StartMs:     unixMilli(point.StartTime),
			Attributes:  emptyMapNil(attrs),
		})
	}
	return out
}

func logRecords(records []sdklog.Record) []LogRecord {
	out := make([]LogRecord, 0, min(len(records), maxCapturedLogs))
	for _, record := range records {
		if len(out) >= maxCapturedLogs {
			break
		}
		attrs := logAttributes(record)
		service := resourceAttribute(record.Resource(), string(semconv.ServiceNameKey))
		traceID := record.TraceID().String()
		if strings.Trim(traceID, "0") == "" {
			traceID = ""
		}
		spanID := record.SpanID().String()
		if strings.Trim(spanID, "0") == "" {
			spanID = ""
		}
		out = append(out, LogRecord{
			Severity:    emptyFallback(record.SeverityText(), record.Severity().String()),
			Body:        record.Body().AsString(),
			Service:     service,
			Operation:   popAttribute(attrs, "operation.name"),
			TimestampMs: unixMilli(record.Timestamp()),
			TraceID:     traceID,
			SpanID:      spanID,
			Attributes:  emptyMapNil(attrs),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TimestampMs != out[j].TimestampMs {
			return out[i].TimestampMs < out[j].TimestampMs
		}
		return out[i].Severity < out[j].Severity
	})
	return out
}

func attributeSet(set attribute.Set) map[string]string {
	out := make(map[string]string, set.Len())
	for iter := set.Iter(); iter.Next(); {
		attr := iter.Attribute()
		out[string(attr.Key)] = attr.Value.AsString()
	}
	return out
}

func logAttributes(record sdklog.Record) map[string]string {
	out := make(map[string]string, record.AttributesLen())
	record.WalkAttributes(func(kv log.KeyValue) bool {
		out[kv.Key] = kv.Value.String()
		return true
	})
	return out
}

func resourceAttribute(res *resource.Resource, key string) string {
	if res == nil {
		return ""
	}
	value, ok := res.Set().Value(attribute.Key(key))
	if !ok {
		return ""
	}
	return value.AsString()
}

func popAttribute(attrs map[string]string, key string) string {
	value := attrs[key]
	delete(attrs, key)
	return value
}

func emptyMapNil(attrs map[string]string) map[string]string {
	if len(attrs) == 0 {
		return nil
	}
	return attrs
}

func unixMilli(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func extremaValue[N int64 | float64](value metricdata.Extrema[N]) float64 {
	v, defined := value.Value()
	if !defined {
		return 0
	}
	return float64(v)
}

func ToJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf(`{"ok":false,"errors":[{"severity":"error","message":%q}]}`, err.Error())
	}
	return string(data)
}

type rateSample struct {
	elapsed time.Duration
	rate    float64
}

type previewForecast struct {
	expectedTraces     float64
	expectedSpans      float64
	expectedErrors     float64
	maxSpans           int
	maxSpansRoot       string
	maxFanOut          int
	maxFanOutRef       string
	spanDist           synth.DistributionSummary
	fanOutDist         synth.DistributionSummary
	shapeScenarios     []string
	rateVaries         bool
	spanVaries         bool
	asyncCalls         int
	probabilisticCalls int
	scenarioTraffic    int
}

type previewMetric struct {
	label string
	value string
}

func renderPreviewSVG(cfg synth.TrafficConfig, traffic synth.TrafficPattern, scenarios []synth.Scenario, duration time.Duration, summary *TopologySummary, topo *synth.Topology) string {
	const (
		width  = 860
		height = 500
		left   = 64
		right  = 24
		top    = 132
		bottom = 170
	)

	plotW := width - left - right
	plotH := height - top - bottom
	samples := sampleRates(traffic, scenarios, duration)
	maxRate := 1.0
	observedMaxRate := 0.0
	minRate := math.Inf(1)
	for _, sample := range samples {
		maxRate = math.Max(maxRate, sample.rate)
		observedMaxRate = math.Max(observedMaxRate, sample.rate)
		minRate = math.Min(minRate, sample.rate)
	}
	maxRate *= 1.12
	forecast := buildPreviewForecast(topo, samples, duration, scenarios)
	if len(samples) > 0 {
		forecast.rateVaries = observedMaxRate-minRate > 0.001
	}

	trafficLabel := trafficPatternLabel(cfg)
	metrics := []previewMetric{
		{label: "expected traces", value: compactNumber(forecast.expectedTraces)},
		{label: "expected spans", value: compactNumber(forecast.expectedSpans)},
		{label: "expected errors", value: compactNumber(forecast.expectedErrors)},
		{label: "root ops", value: fmt.Sprintf("%d", len(summary.Roots))},
		{label: "max fanout", value: fmt.Sprintf("%d", forecast.maxFanOut)},
		{label: "p95 spans/trace", value: fmt.Sprintf("%d", forecast.spanDist.P95)},
	}

	var b strings.Builder
	b.WriteString(fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" role="img" aria-label="Traffic preview" data-rate-variation="%t" data-span-variation="%t" data-scenarios="%d" data-shape-max-spans="%d" data-shape-scenarios="%d">`, width, height, forecast.rateVaries, forecast.spanVaries, len(scenarios), forecast.spanDist.Max, len(forecast.shapeScenarios)))
	b.WriteString(`<rect width="100%" height="100%" class="preview-bg"/>`)
	b.WriteString(`<style>text{font-family:ui-sans-serif,system-ui,sans-serif;fill:var(--ink)}.preview-bg{fill:var(--surface)}.label{font-size:11px;fill:var(--muted)}.eyebrow{font-size:10px;fill:var(--muted);text-transform:uppercase}.title{font-size:14px;font-weight:720}.small{font-size:10px;fill:var(--muted)}.grid{stroke:var(--line);stroke-width:1}.axis{stroke:var(--line-strong);stroke-width:1}.line{fill:none;stroke:var(--ink);stroke-width:2.5;stroke-linejoin:round}.scenario{fill:var(--muted);fill-opacity:.1;stroke:var(--muted);stroke-opacity:.35}.scenario-traffic{fill:var(--ink);fill-opacity:.11;stroke:var(--ink);stroke-opacity:.32}.scenario-label{font-size:10px;fill:var(--muted-strong)}.card{fill:var(--surface-raised);stroke:var(--line);stroke-width:1}.card-value{font-size:17px;font-weight:720}.card-label{font-size:10px;fill:var(--muted)}.bar{fill:var(--ink)}.bar-bg{fill:var(--surface-sunken)}.note{font-size:11px;fill:var(--muted-strong)}</style>`)
	b.WriteString(fmt.Sprintf(`<text x="%d" y="24" class="title">Traffic forecast: %s over %s</text>`, left, html.EscapeString(trafficLabel), formatDuration(duration)))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="44" class="label">%d services, %d operations, %d call edges</text>`, left, len(summary.Services), summary.Operations, summary.Edges))

	cardW := 116
	cardGap := 10
	for i, metric := range metrics {
		x := left + i*(cardW+cardGap)
		b.WriteString(fmt.Sprintf(`<rect x="%d" y="58" width="%d" height="48" rx="6" class="card"/>`, x, cardW))
		b.WriteString(fmt.Sprintf(`<text x="%d" y="80" class="card-value">%s</text>`, x+10, html.EscapeString(metric.value)))
		b.WriteString(fmt.Sprintf(`<text x="%d" y="96" class="card-label">%s</text>`, x+10, html.EscapeString(metric.label)))
	}

	for i := 0; i <= 4; i++ {
		y := top + plotH - int(float64(i)*float64(plotH)/4)
		rate := maxRate * float64(i) / 4
		b.WriteString(fmt.Sprintf(`<line x1="%d" y1="%d" x2="%d" y2="%d" class="grid"/>`, left, y, left+plotW, y))
		b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" text-anchor="end" class="label">%.1f/s</text>`, left-8, y+4, rate))
	}
	b.WriteString(fmt.Sprintf(`<line x1="%d" y1="%d" x2="%d" y2="%d" class="axis"/>`, left, top+plotH, left+plotW, top+plotH))

	for _, scenario := range scenarios {
		if scenario.End <= 0 || scenario.Start >= duration {
			continue
		}
		start := max(scenario.Start, 0)
		end := min(scenario.End, duration)
		x := left + int(float64(plotW)*float64(start)/float64(duration))
		w := int(float64(plotW) * float64(end-start) / float64(duration))
		if w < 1 {
			w = 1
		}
		className := "scenario"
		label := scenario.Name
		if scenario.Traffic != nil {
			className = "scenario-traffic"
			label += " traffic"
		}
		b.WriteString(fmt.Sprintf(`<rect x="%d" y="%d" width="%d" height="%d" class="%s"/>`, x, top, w, plotH, className))
		labelX := min(max(x+5, left), left+plotW-120)
		b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="scenario-label">%s</text>`, labelX, top-8, html.EscapeString(shorten(label, 30))))
	}

	points := make([]string, 0, len(samples))
	for _, sample := range samples {
		x := left + int(float64(plotW)*float64(sample.elapsed)/float64(duration))
		y := top + plotH - int(float64(plotH)*sample.rate/maxRate)
		points = append(points, fmt.Sprintf("%d,%d", x, y))
	}
	b.WriteString(fmt.Sprintf(`<polyline class="line" points="%s"/>`, strings.Join(points, " ")))

	for i := 0; i <= 5; i++ {
		x := left + int(float64(i)*float64(plotW)/5)
		elapsed := time.Duration(float64(i) * float64(duration) / 5)
		b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" text-anchor="middle" class="label">%s</text>`, x, top+plotH+18, formatDuration(elapsed)))
	}
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" text-anchor="middle" class="small">elapsed run time (%s)</text>`, left+plotW/2, top+plotH+36, formatDuration(duration)))

	if !forecast.rateVaries {
		b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="note">Static arrival rate; forecast still uses roots, probabilities, fanout, and errors.</text>`, left, top+plotH+58))
	}

	detailY := top + plotH + 96
	drawTraceShape(&b, forecast, left, detailY, 304, 62)
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="small">largest root trace: %s</text>`, left+328, detailY+14, html.EscapeString(emptyFallback(shorten(forecast.maxSpansRoot, 42), "none"))))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="small">widest operation: %s</text>`, left+328, detailY+32, html.EscapeString(emptyFallback(shorten(forecast.maxFanOutRef, 42), "none"))))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="small">sample max: %d spans/trace, %d child calls</text>`, left+328, detailY+50, forecast.spanDist.Max, forecast.fanOutDist.Max))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="small">%d async calls, %d probabilistic calls, %d scenario traffic windows</text>`, left+328, detailY+68, forecast.asyncCalls, forecast.probabilisticCalls, forecast.scenarioTraffic))

	b.WriteString(`</svg>`)
	return b.String()
}

func buildPreviewForecast(topo *synth.Topology, samples []rateSample, duration time.Duration, scenarios []synth.Scenario) previewForecast {
	shapeScenarios := overlappingScenarios(scenarios, duration)
	checks := synth.Check(topo, synth.CheckOptions{
		MaxDepth:         12,
		MaxFanOut:        12,
		MaxSpans:         maxSpansPerTrace,
		MaxSpansPerTrace: maxSpansPerTrace,
		Samples:          64,
		Seed:             17,
		Scenarios:        shapeScenarios,
	})
	spanCheck := findCheck(checks, "max-spans")
	fanOutCheck := findCheck(checks, "max-fan-out")
	spanDist := distributionOrZero(spanCheck)
	fanOutDist := distributionOrZero(fanOutCheck)
	typicalSpans := spanDist.P50
	if typicalSpans == 0 && len(topo.Roots) > 0 {
		typicalSpans = 1
	}
	maxSpans, maxSpansRoot := synth.MaxSpans(topo)
	maxFanOut := fanOutCheck.Actual
	maxFanOutRef := fanOutCheck.Ref
	if maxFanOut == 0 {
		maxFanOut, maxFanOutRef = synth.MaxFanOut(topo)
	}
	asyncCalls, probabilisticCalls := callShape(topo)
	scenarioTraffic := 0
	for _, scenario := range scenarios {
		if scenario.Traffic != nil {
			scenarioTraffic++
		}
	}
	expectedTraces := integrateRates(samples, duration)
	return previewForecast{
		expectedTraces:     expectedTraces,
		expectedSpans:      expectedTraces * float64(typicalSpans),
		expectedErrors:     expectedTraces * expectedErrorsPerTrace(topo),
		maxSpans:           maxSpans,
		maxSpansRoot:       maxSpansRoot,
		maxFanOut:          maxFanOut,
		maxFanOutRef:       maxFanOutRef,
		spanDist:           spanDist,
		fanOutDist:         fanOutDist,
		shapeScenarios:     spanCheck.Scenarios,
		spanVaries:         spanDist.P50 != spanDist.Max,
		asyncCalls:         asyncCalls,
		probabilisticCalls: probabilisticCalls,
		scenarioTraffic:    scenarioTraffic,
	}
}

func overlappingScenarios(scenarios []synth.Scenario, duration time.Duration) []synth.Scenario {
	if duration <= 0 {
		return nil
	}
	active := make([]synth.Scenario, 0, len(scenarios))
	for _, scenario := range scenarios {
		if scenario.End > 0 && scenario.Start < duration {
			active = append(active, scenario)
		}
	}
	return active
}

func findCheck(checks []synth.CheckResult, name string) synth.CheckResult {
	for _, check := range checks {
		if check.Name == name {
			return check
		}
	}
	return synth.CheckResult{}
}

func distributionOrZero(check synth.CheckResult) synth.DistributionSummary {
	if check.Distribution == nil {
		return synth.DistributionSummary{}
	}
	return *check.Distribution
}

func integrateRates(samples []rateSample, duration time.Duration) float64 {
	if len(samples) == 0 || duration <= 0 {
		return 0
	}
	if len(samples) == 1 {
		return samples[0].rate * duration.Seconds()
	}
	var total float64
	for i := 1; i < len(samples); i++ {
		seconds := samples[i].elapsed.Seconds() - samples[i-1].elapsed.Seconds()
		if seconds <= 0 {
			continue
		}
		total += ((samples[i-1].rate + samples[i].rate) / 2) * seconds
	}
	return total
}

func expectedErrorsPerTrace(topo *synth.Topology) float64 {
	if len(topo.Roots) == 0 {
		return 0
	}
	var total float64
	for _, root := range topo.Roots {
		total += expectedErrorsFromOperation(root, make(map[*synth.Operation]bool))
	}
	return total / float64(len(topo.Roots))
}

func expectedErrorsFromOperation(op *synth.Operation, visited map[*synth.Operation]bool) float64 {
	if visited[op] {
		return 0
	}
	visited[op] = true
	defer delete(visited, op)

	total := op.ErrorRate
	for _, call := range op.Calls {
		probability := call.Probability
		if probability <= 0 {
			probability = 1
		}
		count := max(call.Count, 1) * (1 + call.Retries)
		total += probability * float64(count) * expectedErrorsFromOperation(call.Operation, visited)
	}
	return total
}

func callShape(topo *synth.Topology) (asyncCalls int, probabilisticCalls int) {
	for _, svc := range topo.Services {
		for _, op := range svc.Operations {
			for _, call := range op.Calls {
				if call.Async {
					asyncCalls++
				}
				if call.Probability > 0 && call.Probability < 1 {
					probabilisticCalls++
				}
			}
		}
	}
	return asyncCalls, probabilisticCalls
}

func drawTraceShape(b *strings.Builder, forecast previewForecast, x, y, width, height int) {
	label := "trace shape sample"
	if len(forecast.shapeScenarios) > 0 {
		label += ": " + shorten(strings.Join(forecast.shapeScenarios, ", "), 28)
	}
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="eyebrow">%s</text>`, x, y-10, html.EscapeString(label)))
	b.WriteString(fmt.Sprintf(`<rect x="%d" y="%d" width="%d" height="%d" rx="4" class="bar-bg"/>`, x, y, width, height))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="card-value">%d</text>`, x+12, y+28, forecast.spanDist.P50))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="card-label">p50 spans</text>`, x+12, y+46))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="card-value">%d</text>`, x+118, y+28, forecast.spanDist.P95))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="card-label">p95 spans</text>`, x+118, y+46))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="card-value">%d</text>`, x+222, y+28, forecast.spanDist.Max))
	b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="card-label">max spans</text>`, x+222, y+46))
}

func trafficPatternLabel(cfg synth.TrafficConfig) string {
	pattern := trafficPatternName(cfg)
	if cfg.Rate != "" {
		pattern += " " + cfg.Rate
	}
	if cfg.Overlay != nil {
		pattern += " + " + trafficPatternName(*cfg.Overlay) + " overlay"
	}
	return pattern
}

func trafficPatternName(cfg synth.TrafficConfig) string {
	switch cfg.Pattern {
	case "", "uniform":
		return "uniform"
	case "diurnal":
		return "short-period diurnal"
	case "bursty":
		return "bursty"
	case "custom":
		return "custom segments"
	default:
		return cfg.Pattern
	}
}

func compactNumber(value float64) string {
	abs := math.Abs(value)
	switch {
	case abs >= 1_000_000:
		return fmt.Sprintf("%.1fm", value/1_000_000)
	case abs >= 10_000:
		return fmt.Sprintf("%.0fk", value/1_000)
	case abs >= 1_000:
		return fmt.Sprintf("%.1fk", value/1_000)
	case abs >= 100:
		return fmt.Sprintf("%.0f", value)
	case abs >= 10:
		return fmt.Sprintf("%.1f", value)
	case abs >= 0.05:
		return fmt.Sprintf("%.1f", value)
	default:
		return "0"
	}
}

func emptyFallback(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func shorten(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit || limit <= 0 {
		return value
	}
	if limit <= 3 {
		return string(runes[:limit])
	}
	return string(runes[:limit-3]) + "..."
}

func sampleRates(traffic synth.TrafficPattern, scenarios []synth.Scenario, duration time.Duration) []rateSample {
	interval := previewSampleInterval(duration)
	count := int(duration/interval) + 2
	samples := make([]rateSample, 0, count)
	for elapsed := time.Duration(0); elapsed < duration; elapsed += interval {
		rate := traffic.Rate(elapsed)
		active := synth.ActiveScenarios(scenarios, elapsed)
		if override := synth.ResolveTraffic(active); override != nil {
			rate = override.Rate(elapsed)
		}
		samples = append(samples, rateSample{elapsed: elapsed, rate: rate})
	}
	if len(samples) == 0 || samples[len(samples)-1].elapsed != duration {
		rate := traffic.Rate(duration)
		active := synth.ActiveScenarios(scenarios, duration)
		if override := synth.ResolveTraffic(active); override != nil {
			rate = override.Rate(duration)
		}
		samples = append(samples, rateSample{elapsed: duration, rate: rate})
	}
	return samples
}

func previewSampleInterval(duration time.Duration) time.Duration {
	switch {
	case duration <= time.Second:
		return max(duration/40, 25*time.Millisecond)
	case duration <= 10*time.Second:
		return max(duration/80, 50*time.Millisecond)
	case duration > 10*time.Minute:
		return 5 * time.Second
	default:
		return time.Second
	}
}

func formatDuration(d time.Duration) string {
	if d > 0 && d < time.Second {
		return fmt.Sprintf("%.0fms", float64(d)/float64(time.Millisecond))
	}
	if d >= time.Minute {
		return fmt.Sprintf("%.0fm", d.Minutes())
	}
	return fmt.Sprintf("%.0fs", d.Seconds())
}
