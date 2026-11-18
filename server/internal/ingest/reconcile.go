package ingest

import (
	"context"
	"time"

	"request-monitor/internal/gateway"
	"request-monitor/internal/store"
)

// countingAdapter is a gateway that can count its own requests per bucket, Channel, and status.
type countingAdapter interface {
	CountByBucket(ctx context.Context, from, to time.Time, fn func(bucket int64, channel, status string, n int64) error) error
}

// ReconcileResult is the outcome of a comparison.
type ReconcileResult struct {
	GatewayTotal int64
	RollupTotal  int64
	Cells        int
	Different    int
}

type reconcileCell struct {
	bucket, route int64
	status        gateway.Status
}

// Reconcile compares the stored route rollups of buckets [from, to) with counts taken straight
// from the gateway.
func Reconcile(ctx context.Context, adapter countingAdapter, st *store.Store, from, to int64) (ReconcileResult, error) {
	var result ReconcileResult
	routes, err := st.Routes()
	if err != nil {
		return result, err
	}
	byChannel := map[string]int64{}
	var unknown int64
	for _, r := range routes {
		if r.GroupKey == "" && r.ChannelKey == "" {
			unknown = r.ID
			continue
		}
		byChannel[r.ChannelKey] = r.ID
	}
	expected := map[reconcileCell]int64{}
	err = adapter.CountByBucket(ctx, store.BucketStart(from), store.BucketStart(to), func(bucket int64, channel, status string, n int64) error {
		var s gateway.Status
		switch status {
		case "success":
			s = gateway.StatusSuccess
		case "error":
			s = gateway.StatusError
		case "client_gone":
			s = gateway.StatusClientGone
		default:
			return nil
		}
		route := store.RejectedRoute
		if channel != "" {
			var ok bool
			if route, ok = byChannel[channel]; !ok {
				route = unknown
			}
		}
		expected[reconcileCell{bucket, route, s}] += n
		result.GatewayTotal += n
		return nil
	})
	if err != nil {
		return result, err
	}
	actual := map[reconcileCell]int64{}
	if err := st.EachRoute(ctx, from, to, func(bucket, route int64, status gateway.Status, n int64) {
		actual[reconcileCell{bucket, route, status}] += n
		result.RollupTotal += n
	}); err != nil {
		return result, err
	}
	for cell, n := range expected {
		result.Cells++
		if actual[cell] != n {
			result.Different++
		}
	}
	for cell := range actual {
		if _, ok := expected[cell]; !ok {
			result.Cells++
			result.Different++
		}
	}
	return result, nil
}
