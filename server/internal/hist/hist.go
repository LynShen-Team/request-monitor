// Package hist is a fixed-bin latency histogram. Medians of different buckets cannot be added,
// histograms can: the service stores one per 5-minute bucket and route, and merges them to answer
// a longer step (spec OS-B4).
package hist

import (
	"encoding/binary"
	"errors"
	"math"
)

// Bins is the number of bins. Bin i covers [First * Ratio^i, First * Ratio^(i+1)) milliseconds;
// the first bin also takes every smaller value and the last bin every larger one.
const (
	Bins  = 48
	First = 10.0
	Ratio = 1.28
)

// H counts latencies in milliseconds.
type H struct {
	Counts [Bins]uint64
}

var logRatio = math.Log(Ratio)

func binOf(ms float64) int {
	if ms < First {
		return 0
	}
	i := int(math.Log(ms/First) / logRatio)
	if i >= Bins {
		return Bins - 1
	}
	return i
}

func lower(i int) float64 { return First * math.Pow(Ratio, float64(i)) }

// Add records one latency.
func (h *H) Add(ms int64) { h.Counts[binOf(float64(ms))]++ }

// Merge adds the counts of other.
func (h *H) Merge(other *H) {
	for i := range h.Counts {
		h.Counts[i] += other.Counts[i]
	}
}

// Total is the number of recorded latencies.
func (h *H) Total() uint64 {
	var n uint64
	for _, c := range h.Counts {
		n += c
	}
	return n
}

// Quantile returns the q-quantile in milliseconds, interpolated inside its bin on a log scale. It
// returns 0 for an empty histogram. The error is at most the width of one bin (28 %).
func (h *H) Quantile(q float64) float64 {
	total := h.Total()
	if total == 0 {
		return 0
	}
	rank := q * float64(total)
	var seen float64
	for i, c := range h.Counts {
		if c == 0 {
			continue
		}
		if seen+float64(c) >= rank {
			frac := (rank - seen) / float64(c)
			if frac < 0 {
				frac = 0
			}
			return lower(i) * math.Pow(Ratio, frac)
		}
		seen += float64(c)
	}
	return lower(Bins)
}

// Encode packs the counts as varints: an empty bin costs one byte.
func (h *H) Encode() []byte {
	out := make([]byte, 0, Bins+8)
	for _, c := range h.Counts {
		out = binary.AppendUvarint(out, c)
	}
	return out
}

// Decode reads what Encode wrote.
func Decode(data []byte) (*H, error) {
	h := &H{}
	for i := range h.Counts {
		v, n := binary.Uvarint(data)
		if n <= 0 {
			return nil, errors.New("hist: truncated histogram")
		}
		h.Counts[i] = v
		data = data[n:]
	}
	return h, nil
}
