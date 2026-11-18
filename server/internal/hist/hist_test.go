package hist

import (
	"math"
	"testing"
)

func TestQuantileIsWithinOneBin(t *testing.T) {
	var h H
	for ms := int64(100); ms <= 5000; ms += 7 {
		h.Add(ms)
	}
	// The true median of 100, 107, …, 4993 is about 2550.
	got := h.Quantile(0.5)
	if got < 2550/Ratio || got > 2550*Ratio {
		t.Fatalf("median = %.0f, want within one bin of 2550", got)
	}
}

func TestEmptyAndExtremes(t *testing.T) {
	var h H
	if h.Quantile(0.5) != 0 {
		t.Fatal("an empty histogram must answer 0")
	}
	h.Add(0)
	h.Add(1 << 40)
	if h.Total() != 2 || h.Counts[0] != 1 || h.Counts[Bins-1] != 1 {
		t.Fatalf("out-of-range values must land in the first and the last bin: %v", h.Counts)
	}
}

func TestEncodeDecodeAndMerge(t *testing.T) {
	var a, b H
	for i := int64(1); i < 2000; i += 3 {
		a.Add(i * 5)
		b.Add(i * 11)
	}
	decoded, err := Decode(a.Encode())
	if err != nil || *decoded != a {
		t.Fatalf("decode(encode(h)) != h: %v", err)
	}
	sum := a
	sum.Merge(&b)
	if sum.Total() != a.Total()+b.Total() {
		t.Fatal("merge must add the counts")
	}
	if _, err := Decode([]byte{1, 2}); err == nil {
		t.Fatal("a truncated histogram must be an error")
	}
	if math.IsNaN(sum.Quantile(0.95)) {
		t.Fatal("quantile must be a number")
	}
}
