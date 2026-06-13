package playground

import (
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
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"gopkg.in/yaml.v3"
)

const (
	maxDuration         = 10 * time.Second
	defaultDuration     = time.Second
	maxTraces           = 200
	maxSpansPerTrace    = 500
	maxCapturedSpans    = 1000
	defaultPreviewRange = 5 * time.Minute
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

type rawConfig struct {
	Version   *int                        `yaml:"version"`
	Services  map[string]rawServiceConfig `yaml:"services"`
	Traffic   synth.TrafficConfig         `yaml:"traffic"`
	Scenarios []synth.ScenarioConfig      `yaml:"scenarios,omitempty"`
}

type rawServiceConfig struct {
	ResourceAttributes map[string]string             `yaml:"resource_attributes,omitempty"`
	Attributes         map[string]string             `yaml:"attributes,omitempty"`
	Metrics            []synth.MetricConfig          `yaml:"metrics,omitempty"`
	Logs               []synth.LogConfig             `yaml:"logs,omitempty"`
	Operations         map[string]rawOperationConfig `yaml:"operations"`
}

type rawOperationConfig struct {
	Domain         string                                `yaml:"domain,omitempty"`
	Duration       string                                `yaml:"duration"`
	ErrorRate      string                                `yaml:"error_rate,omitempty"`
	Calls          []synth.CallConfig                    `yaml:"calls,omitempty"`
	CallStyle      string                                `yaml:"call_style,omitempty"`
	Attributes     map[string]synth.AttributeValueConfig `yaml:"attributes,omitempty"`
	Events         []synth.EventConfig                   `yaml:"events,omitempty"`
	Links          []string                              `yaml:"links,omitempty"`
	Metrics        []synth.MetricConfig                  `yaml:"metrics,omitempty"`
	Logs           []synth.LogConfig                     `yaml:"logs,omitempty"`
	QueueDepth     int                                   `yaml:"queue_depth,omitempty"`
	Backpressure   *synth.BackpressureConfig             `yaml:"backpressure,omitempty"`
	CircuitBreaker *synth.CircuitBreakerConfig           `yaml:"circuit_breaker,omitempty"`
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

type RunResult struct {
	OK       bool             `json:"ok"`
	Stats    *synth.Stats     `json:"stats,omitempty"`
	Topology *TopologySummary `json:"topology,omitempty"`
	Spans    []SpanRecord     `json:"spans,omitempty"`
	Errors   []Diagnostic     `json:"errors,omitempty"`
	Limits   RunLimits        `json:"limits"`
}

type RunLimits struct {
	DurationSeconds  float64 `json:"duration_seconds"`
	MaxTraces        int     `json:"max_traces"`
	MaxSpansPerTrace int     `json:"max_spans_per_trace"`
	CapturedSpans    int     `json:"captured_spans"`
}

type captureObserver struct {
	mu    sync.Mutex
	spans []SpanRecord
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

func Run(source string, duration time.Duration, seed uint64) RunResult {
	if duration <= 0 {
		duration = defaultDuration
	}
	if duration > maxDuration {
		duration = maxDuration
	}

	cfg, topo, scenarios, err := load(source)
	if err != nil {
		return RunResult{
			OK:     false,
			Errors: []Diagnostic{{Severity: "error", Message: err.Error()}},
			Limits: limits(duration, 0),
		}
	}

	traffic, err := synth.NewTrafficPattern(cfg.Traffic)
	if err != nil {
		return RunResult{
			OK:     false,
			Errors: []Diagnostic{{Severity: "error", Message: err.Error()}},
			Limits: limits(duration, 0),
		}
	}

	observer := &captureObserver{}
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
		Observers:        []synth.SpanObserver{observer},
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
			Limits:   limits(duration, 0),
		}
	}

	spans := observer.Records()
	return RunResult{
		OK:       true,
		Stats:    stats,
		Topology: summariseConfig(cfg, topo),
		Spans:    spans,
		Limits:   limits(duration, len(spans)),
	}
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
	return renderPreviewSVG(traffic, scenarios, duration, summariseConfig(cfg, topo)), nil
}

func load(source string) (*synth.Config, *synth.Topology, []synth.Scenario, error) {
	cfg, err := parseConfigBytes([]byte(source))
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

func parseConfigBytes(data []byte) (*synth.Config, error) {
	var raw rawConfig
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	if raw.Version == nil {
		return nil, fmt.Errorf("missing required field: version (e.g. 'version: 1')")
	}
	if *raw.Version != synth.CurrentVersion {
		return nil, fmt.Errorf("unsupported config version %d (supported: %d)", *raw.Version, synth.CurrentVersion)
	}

	cfg := &synth.Config{
		Version:   *raw.Version,
		Traffic:   raw.Traffic,
		Scenarios: raw.Scenarios,
	}

	serviceNames := make([]string, 0, len(raw.Services))
	for name := range raw.Services {
		serviceNames = append(serviceNames, name)
	}
	sort.Strings(serviceNames)

	for _, serviceName := range serviceNames {
		rawSvc := raw.Services[serviceName]
		svc := synth.ServiceConfig{
			Name:               serviceName,
			ResourceAttributes: rawSvc.ResourceAttributes,
			Attributes:         rawSvc.Attributes,
			Metrics:            rawSvc.Metrics,
			Logs:               rawSvc.Logs,
		}

		operationNames := make([]string, 0, len(rawSvc.Operations))
		for name := range rawSvc.Operations {
			operationNames = append(operationNames, name)
		}
		sort.Strings(operationNames)

		for _, operationName := range operationNames {
			rawOp := rawSvc.Operations[operationName]
			svc.Operations = append(svc.Operations, synth.OperationConfig{
				Name:           operationName,
				Domain:         rawOp.Domain,
				Duration:       rawOp.Duration,
				ErrorRate:      rawOp.ErrorRate,
				Calls:          rawOp.Calls,
				CallStyle:      rawOp.CallStyle,
				Attributes:     rawOp.Attributes,
				Events:         rawOp.Events,
				Links:          rawOp.Links,
				Metrics:        rawOp.Metrics,
				Logs:           rawOp.Logs,
				QueueDepth:     rawOp.QueueDepth,
				Backpressure:   rawOp.Backpressure,
				CircuitBreaker: rawOp.CircuitBreaker,
			})
		}
		cfg.Services = append(cfg.Services, svc)
	}

	return cfg, nil
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

func limits(duration time.Duration, captured int) RunLimits {
	return RunLimits{
		DurationSeconds:  duration.Seconds(),
		MaxTraces:        maxTraces,
		MaxSpansPerTrace: maxSpansPerTrace,
		CapturedSpans:    captured,
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

func renderPreviewSVG(traffic synth.TrafficPattern, scenarios []synth.Scenario, duration time.Duration, summary *TopologySummary) string {
	const (
		width  = 860
		height = 320
		left   = 64
		right  = 24
		top    = 34
		bottom = 42
	)

	plotW := width - left - right
	plotH := height - top - bottom
	samples := sampleRates(traffic, scenarios, duration)
	maxRate := 1.0
	for _, sample := range samples {
		maxRate = math.Max(maxRate, sample.rate)
	}
	maxRate *= 1.12

	var b strings.Builder
	b.WriteString(fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" role="img" aria-label="Traffic preview">`, width, height))
	b.WriteString(`<rect width="100%" height="100%" fill="#fbfaf7"/>`)
	b.WriteString(`<style>text{font-family:ui-sans-serif,system-ui,sans-serif;fill:#2d332f}.label{font-size:11px;fill:#667166}.title{font-size:13px;font-weight:700}.grid{stroke:#e5e0d6;stroke-width:1}.line{fill:none;stroke:#0f766e;stroke-width:2.5;stroke-linejoin:round}.scenario{fill:#d97706;fill-opacity:.12;stroke:#d97706;stroke-opacity:.35}.scenario-label{font-size:10px;fill:#8a4b0f}</style>`)
	b.WriteString(fmt.Sprintf(`<text x="%d" y="22" class="title">%d services, %d operations, %d call edges</text>`, left, len(summary.Services), summary.Operations, summary.Edges))

	for i := 0; i <= 4; i++ {
		y := top + plotH - int(float64(i)*float64(plotH)/4)
		rate := maxRate * float64(i) / 4
		b.WriteString(fmt.Sprintf(`<line x1="%d" y1="%d" x2="%d" y2="%d" class="grid"/>`, left, y, left+plotW, y))
		b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" text-anchor="end" class="label">%.1f/s</text>`, left-8, y+4, rate))
	}

	for _, scenario := range scenarios {
		x := left + int(float64(plotW)*float64(scenario.Start)/float64(duration))
		w := int(float64(plotW) * float64(scenario.End-scenario.Start) / float64(duration))
		if w < 1 {
			w = 1
		}
		b.WriteString(fmt.Sprintf(`<rect x="%d" y="%d" width="%d" height="%d" class="scenario"/>`, x, top, w, plotH))
		b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" class="scenario-label">%s</text>`, x+5, top+16, html.EscapeString(scenario.Name)))
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
		b.WriteString(fmt.Sprintf(`<text x="%d" y="%d" text-anchor="middle" class="label">%s</text>`, x, height-16, formatDuration(elapsed)))
	}

	b.WriteString(`</svg>`)
	return b.String()
}

func sampleRates(traffic synth.TrafficPattern, scenarios []synth.Scenario, duration time.Duration) []rateSample {
	interval := time.Second
	if duration > 10*time.Minute {
		interval = 5 * time.Second
	}
	count := int(duration/interval) + 1
	samples := make([]rateSample, 0, count)
	for elapsed := time.Duration(0); elapsed <= duration; elapsed += interval {
		rate := traffic.Rate(elapsed)
		active := synth.ActiveScenarios(scenarios, elapsed)
		if override := synth.ResolveTraffic(active); override != nil {
			rate = override.Rate(elapsed)
		}
		samples = append(samples, rateSample{elapsed: elapsed, rate: rate})
	}
	return samples
}

func formatDuration(d time.Duration) string {
	if d >= time.Minute {
		return fmt.Sprintf("%.0fm", d.Minutes())
	}
	return fmt.Sprintf("%.0fs", d.Seconds())
}
