package playground

import (
	"math"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/andrewh/motel/pkg/synth"
)

const (
	floatTolerance       = 0.0001
	testOperationLatency = 5 * time.Millisecond
)

func TestServiceLayers(t *testing.T) {
	topo := newLayeredTopology()

	got := serviceLayers(topo)
	want := map[string]int{
		"api":      0,
		"auth":     1,
		"worker":   1,
		"database": 2,
		"orphan":   0,
	}

	for serviceName, wantLayer := range want {
		if got[serviceName] != wantLayer {
			t.Errorf("serviceLayers()[%q] = %d, want %d", serviceName, got[serviceName], wantLayer)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("serviceLayers() returned %d services, want %d: %#v", len(got), len(want), got)
	}
}

func TestLayoutGraph(t *testing.T) {
	data := GraphData{
		Nodes: []GraphNode{
			{ID: "api"},
			{ID: "worker"},
			{ID: "auth"},
			{ID: "database"},
		},
		Edges: []GraphEdge{
			{Source: "api", Target: "worker"},
			{Source: "api", Target: "auth"},
			{Source: "worker", Target: "database"},
			{Source: "auth", Target: "database"},
		},
	}
	layers := map[string]int{
		"api":      0,
		"worker":   1,
		"auth":     1,
		"database": 2,
	}

	layoutGraph(&data, layers)

	if data.GridCols != 3 {
		t.Errorf("GridCols = %d, want 3", data.GridCols)
	}
	if data.GridRows != 2 {
		t.Errorf("GridRows = %d, want 2", data.GridRows)
	}
	assertNodePosition(t, data.Nodes, "api", 0, 1)
	assertNodePosition(t, data.Nodes, "auth", 1, 0)
	assertNodePosition(t, data.Nodes, "worker", 1, 1)
	assertNodePosition(t, data.Nodes, "database", 2, 1)
}

func TestLayoutGraphEmpty(t *testing.T) {
	var data GraphData

	layoutGraph(&data, nil)

	if data.GridCols != 1 {
		t.Errorf("GridCols = %d, want 1", data.GridCols)
	}
	if data.GridRows != 1 {
		t.Errorf("GridRows = %d, want 1", data.GridRows)
	}
}

func TestInferPreviewDuration(t *testing.T) {
	tests := []struct {
		name      string
		scenarios []synth.Scenario
		want      time.Duration
	}{
		{
			name: "uses default when no scenarios exist",
			want: defaultPreviewRange,
		},
		{
			name: "pads latest scenario end",
			scenarios: []synth.Scenario{
				{Name: "warmup", Start: time.Second, End: 30 * time.Second},
				{Name: "incident", Start: time.Minute, End: 2 * time.Minute},
			},
			want: 132 * time.Second,
		},
		{
			name:      "zero-length scenarios keep zero duration",
			scenarios: []synth.Scenario{{Name: "instant"}},
			want:      0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := inferPreviewDuration(tt.scenarios)
			if got != tt.want {
				t.Errorf("inferPreviewDuration() = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestIntegrateRates(t *testing.T) {
	tests := []struct {
		name     string
		samples  []rateSample
		duration time.Duration
		want     float64
	}{
		{
			name:     "empty samples",
			duration: 10 * time.Second,
		},
		{
			name:    "non-positive duration",
			samples: []rateSample{{elapsed: 0, rate: 5}},
		},
		{
			name:     "single sample applies for full duration",
			samples:  []rateSample{{elapsed: 0, rate: 3.5}},
			duration: 4 * time.Second,
			want:     14,
		},
		{
			name: "trapezoid integration",
			samples: []rateSample{
				{elapsed: 0, rate: 2},
				{elapsed: 5 * time.Second, rate: 4},
				{elapsed: 10 * time.Second, rate: 6},
			},
			duration: 10 * time.Second,
			want:     40,
		},
		{
			name: "ignores duplicate elapsed samples",
			samples: []rateSample{
				{elapsed: 0, rate: 2},
				{elapsed: 0, rate: 8},
				{elapsed: 2 * time.Second, rate: 4},
			},
			duration: 2 * time.Second,
			want:     12,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := integrateRates(tt.samples, tt.duration)
			assertFloat(t, got, tt.want)
		})
	}
}

func TestExpectedErrorsFromOperation(t *testing.T) {
	root := testOperation("api", "root", 0.1)
	child := testOperation("backend", "work", 0.2)
	leaf := testOperation("database", "query", 0.4)
	root.Calls = []synth.Call{{Operation: child, Probability: 0.5, Count: 2, Retries: 1}}
	child.Calls = []synth.Call{{Operation: leaf}}
	leaf.Calls = []synth.Call{{Operation: root}}

	got := expectedErrorsFromOperation(root, make(map[*synth.Operation]bool))

	assertFloat(t, got, 1.3)
}

func TestBuildPreviewForecast(t *testing.T) {
	topo := newForecastTopology()
	duration := 10 * time.Second
	samples := []rateSample{
		{elapsed: 0, rate: 2},
		{elapsed: duration, rate: 4},
	}
	scenarios := []synth.Scenario{
		{
			Name:    "surge",
			Start:   2 * time.Second,
			End:     8 * time.Second,
			Traffic: &synth.UniformPattern{BaseRate: 7},
		},
	}

	got := buildPreviewForecast(topo, samples, duration, scenarios)

	assertFloat(t, got.expectedTraces, 30)
	assertFloat(t, got.expectedSpans, 90)
	assertFloat(t, got.expectedErrors, 15)
	if got.maxSpans != 3 {
		t.Errorf("maxSpans = %d, want 3", got.maxSpans)
	}
	if got.maxSpansRoot != "api.root" {
		t.Errorf("maxSpansRoot = %q, want %q", got.maxSpansRoot, "api.root")
	}
	if got.maxFanOut != 2 {
		t.Errorf("maxFanOut = %d, want 2", got.maxFanOut)
	}
	if got.maxFanOutRef != "api.root" {
		t.Errorf("maxFanOutRef = %q, want %q", got.maxFanOutRef, "api.root")
	}
	if got.spanDist.P50 != 3 || got.spanDist.P95 != 3 || got.spanDist.Max != 3 {
		t.Errorf("spanDist = %#v, want p50/p95/max of 3", got.spanDist)
	}
	if got.fanOutDist.P50 != 2 || got.fanOutDist.P95 != 2 || got.fanOutDist.Max != 2 {
		t.Errorf("fanOutDist = %#v, want p50/p95/max of 2", got.fanOutDist)
	}
	if got.spanVaries {
		t.Errorf("spanVaries = true, want false")
	}
	if got.scenarioTraffic != 1 {
		t.Errorf("scenarioTraffic = %d, want 1", got.scenarioTraffic)
	}
}

func TestCompactNumber(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		want  string
	}{
		{name: "zero", want: "0"},
		{name: "below display threshold", value: 0.04, want: "0"},
		{name: "small decimal", value: 0.05, want: "0.1"},
		{name: "single digit", value: 9.94, want: "9.9"},
		{name: "double digit", value: 10, want: "10.0"},
		{name: "hundreds", value: 999.4, want: "999"},
		{name: "thousands", value: 1_200, want: "1.2k"},
		{name: "large thousands", value: 12_345, want: "12k"},
		{name: "millions", value: 1_500_000, want: "1.5m"},
		{name: "negative thousands", value: -1_200, want: "-1.2k"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := compactNumber(tt.value)
			if got != tt.want {
				t.Errorf("compactNumber(%g) = %q, want %q", tt.value, got, tt.want)
			}
		})
	}
}

func TestShorten(t *testing.T) {
	tests := []struct {
		name  string
		value string
		limit int
		want  string
	}{
		{"shorter than limit", "hello", 10, "hello"},
		{"equal to limit", "hello", 5, "hello"},
		{"zero limit returns input", "hello", 0, "hello"},
		{"negative limit returns input", "hello", -1, "hello"},
		{"ascii truncation adds ellipsis", "hello world", 8, "hello..."},
		{"ascii tiny limit no ellipsis", "hello", 3, "hel"},
		{"multibyte under limit unchanged", "日本語", 10, "日本語"},
		{"multibyte truncation by rune", "日本語ます", 4, "日..."},
		{"multibyte tiny limit by rune", "日本語", 2, "日本"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shorten(tt.value, tt.limit)
			if got != tt.want {
				t.Errorf("shorten(%q, %d) = %q, want %q", tt.value, tt.limit, got, tt.want)
			}
			if !utf8.ValidString(got) {
				t.Errorf("shorten(%q, %d) produced invalid UTF-8: %q", tt.value, tt.limit, got)
			}
		})
	}
}

func newLayeredTopology() *synth.Topology {
	apiRoot := testOperation("api", "root", 0)
	authCheck := testOperation("auth", "check", 0)
	workerProcess := testOperation("worker", "process", 0)
	databaseQuery := testOperation("database", "query", 0)
	orphanIdle := testOperation("orphan", "idle", 0)

	apiRoot.Calls = []synth.Call{
		{Operation: authCheck},
		{Operation: workerProcess},
	}
	authCheck.Calls = []synth.Call{{Operation: databaseQuery}}

	return topologyFromOperations(apiRoot, authCheck, workerProcess, databaseQuery, orphanIdle)
}

func newForecastTopology() *synth.Topology {
	apiRoot := testOperation("api", "root", 0.1)
	backendWork := testOperation("backend", "work", 0.2)
	apiRoot.Calls = []synth.Call{{Operation: backendWork, Count: 2}}

	return topologyFromOperations(apiRoot, backendWork)
}

func topologyFromOperations(ops ...*synth.Operation) *synth.Topology {
	topo := &synth.Topology{
		Services: make(map[string]*synth.Service),
	}
	called := make(map[*synth.Operation]bool, len(ops))
	for _, op := range ops {
		topo.Services[op.Service.Name] = op.Service
		for _, call := range op.Calls {
			called[call.Operation] = true
		}
	}
	for _, op := range ops {
		if !called[op] {
			topo.Roots = append(topo.Roots, op)
		}
	}
	return topo
}

func testOperation(serviceName, operationName string, errorRate float64) *synth.Operation {
	svc := &synth.Service{
		Name:       serviceName,
		Operations: make(map[string]*synth.Operation),
	}
	op := &synth.Operation{
		Service:   svc,
		Name:      operationName,
		Ref:       serviceName + "." + operationName,
		Duration:  synth.Distribution{Mean: testOperationLatency},
		ErrorRate: errorRate,
	}
	svc.Operations[operationName] = op
	return op
}

func assertNodePosition(t *testing.T, nodes []GraphNode, id string, wantCol, wantRow int) {
	t.Helper()
	for _, node := range nodes {
		if node.ID != id {
			continue
		}
		if node.Col != wantCol || node.Row != wantRow {
			t.Fatalf("%s position = (%d, %d), want (%d, %d)", id, node.Col, node.Row, wantCol, wantRow)
		}
		return
	}
	t.Fatalf("node %q not found in %#v", id, nodes)
}

func assertFloat(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > floatTolerance {
		t.Fatalf("got %g, want %g", got, want)
	}
}
