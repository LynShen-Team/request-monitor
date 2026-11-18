package lynshen

import (
	"context"
	"database/sql"
)

// BeginForTest opens the transaction every read of the adapter runs in.
func (a *Adapter) BeginForTest(ctx context.Context) (*sql.Tx, error) { return a.begin(ctx) }
