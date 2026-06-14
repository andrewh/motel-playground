package playground

import (
	"testing"
	"unicode/utf8"
)

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
