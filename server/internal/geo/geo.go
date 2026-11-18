// Package geo turns an IP address into a place, city level at the finest, with a database that
// is a local file. No address ever leaves the process (spec OS-B3).
package geo

import (
	"bufio"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"

	"github.com/oschwald/maxminddb-golang"
)

// Place is where an address is. Province and City may be empty.
type Place struct {
	CountryCode string // ISO 3166-1 alpha-2
	Country     string
	Province    string
	City        string
	Lat, Lon    float64
}

// Attribution is the credit line a database licence requires on the page.
type Attribution struct {
	Text string `json:"text"`
	Href string `json:"href"`
}

// Resolver looks addresses up in one local database.
type Resolver interface {
	Lookup(addr netip.Addr) (Place, bool)
	// Attribution is nil when the database requires no credit on the page.
	Attribution() *Attribution
	Close() error
}

// None resolves nothing. It is used when no database is configured.
type None struct{}

func (None) Lookup(netip.Addr) (Place, bool) { return Place{}, false }
func (None) Attribution() *Attribution       { return nil }
func (None) Close() error                    { return nil }

// ParseAddr reads the client address column of a gateway log. It accepts a bare address and an
// address with a port or a zone; anything else is not an address.
func ParseAddr(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return netip.Addr{}, false
	}
	if addr, err := netip.ParseAddr(s); err == nil {
		return addr.Unmap().WithZone(""), true
	}
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().Unmap().WithZone(""), true
	}
	return netip.Addr{}, false
}

// mmdbRecord is the part of the GeoIP2 City schema the screen uses. DB-IP City Lite and MaxMind
// GeoLite2-City both follow it.
type mmdbRecord struct {
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
	Country struct {
		ISOCode string            `maxminddb:"iso_code"`
		Names   map[string]string `maxminddb:"names"`
	} `maxminddb:"country"`
	Subdivisions []struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
	Location struct {
		Latitude  float64 `maxminddb:"latitude"`
		Longitude float64 `maxminddb:"longitude"`
	} `maxminddb:"location"`
}

// MMDB reads a MaxMind-format city database (.mmdb).
type MMDB struct {
	reader   *maxminddb.Reader
	language string
	credit   *Attribution
}

// OpenMMDB opens a city database. language is the preferred name language, for example "zh-CN";
// a name that the database lacks in that language is taken in English.
func OpenMMDB(path, language string) (*MMDB, error) {
	reader, err := maxminddb.Open(path)
	if err != nil {
		return nil, fmt.Errorf("geo: open %s: %w", path, err)
	}
	m := &MMDB{reader: reader, language: language}
	kind := strings.ToLower(reader.Metadata.DatabaseType)
	switch {
	case strings.Contains(kind, "dbip"), strings.Contains(kind, "db-ip"):
		// CC BY 4.0: pages that show results must link back to DB-IP.
		m.credit = &Attribution{Text: "IP Geolocation by DB-IP", Href: "https://db-ip.com"}
	case strings.Contains(kind, "geolite"):
		m.credit = &Attribution{Text: "This product includes GeoLite Data created by MaxMind", Href: "https://www.maxmind.com"}
	}
	return m, nil
}

func (m *MMDB) name(names map[string]string) string {
	if v := names[m.language]; v != "" {
		return v
	}
	return names["en"]
}

func (m *MMDB) Lookup(addr netip.Addr) (Place, bool) {
	var record mmdbRecord
	if err := m.reader.Lookup(net.IP(addr.AsSlice()), &record); err != nil {
		return Place{}, false
	}
	if record.Country.ISOCode == "" {
		return Place{}, false
	}
	place := Place{
		CountryCode: record.Country.ISOCode,
		Country:     m.name(record.Country.Names),
		City:        m.name(record.City.Names),
		Lat:         record.Location.Latitude,
		Lon:         record.Location.Longitude,
	}
	if place.Country == "" {
		place.Country = place.CountryCode
	}
	if len(record.Subdivisions) > 0 {
		place.Province = m.name(record.Subdivisions[0].Names)
	}
	return place, true
}

func (m *MMDB) Attribution() *Attribution { return m.credit }
func (m *MMDB) Close() error              { return m.reader.Close() }

// Table resolves addresses from a list of networks in a CSV file with the columns
// `cidr,country_code,country,province,city,lat,lon`. An operator can use it for networks a public
// database knows nothing about; the demo data uses it so that no database download is needed.
type Table struct {
	entries []tableEntry
}

type tableEntry struct {
	prefix netip.Prefix
	place  Place
}

// OpenTable reads a network table. The most specific matching network wins.
func OpenTable(path string) (*Table, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("geo: open %s: %w", path, err)
	}
	defer file.Close()
	reader := csv.NewReader(bufio.NewReader(file))
	reader.FieldsPerRecord = -1
	reader.Comment = '#'
	table := &Table{}
	for line := 1; ; line++ {
		fields, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("geo: %s: %w", path, err)
		}
		if len(fields) < 7 || strings.EqualFold(strings.TrimSpace(fields[0]), "cidr") {
			continue
		}
		prefix, err := netip.ParsePrefix(strings.TrimSpace(fields[0]))
		if err != nil {
			return nil, fmt.Errorf("geo: %s: record %d: %w", path, line, err)
		}
		lat, errLat := strconv.ParseFloat(strings.TrimSpace(fields[5]), 64)
		lon, errLon := strconv.ParseFloat(strings.TrimSpace(fields[6]), 64)
		if errLat != nil || errLon != nil {
			return nil, fmt.Errorf("geo: %s: record %d: latitude and longitude must be numbers", path, line)
		}
		table.entries = append(table.entries, tableEntry{prefix: prefix.Masked(), place: Place{
			CountryCode: strings.TrimSpace(fields[1]),
			Country:     strings.TrimSpace(fields[2]),
			Province:    strings.TrimSpace(fields[3]),
			City:        strings.TrimSpace(fields[4]),
			Lat:         lat,
			Lon:         lon,
		}})
	}
	return table, nil
}

func (t *Table) Lookup(addr netip.Addr) (Place, bool) {
	best := -1
	for i, entry := range t.entries {
		if entry.prefix.Contains(addr) && (best < 0 || entry.prefix.Bits() > t.entries[best].prefix.Bits()) {
			best = i
		}
	}
	if best < 0 {
		return Place{}, false
	}
	return t.entries[best].place, true
}

func (t *Table) Attribution() *Attribution { return nil }
func (t *Table) Close() error              { return nil }

// Chain asks each resolver in turn and returns the first answer.
type Chain []Resolver

func (c Chain) Lookup(addr netip.Addr) (Place, bool) {
	for _, r := range c {
		if place, ok := r.Lookup(addr); ok {
			return place, true
		}
	}
	return Place{}, false
}

func (c Chain) Attribution() *Attribution {
	for _, r := range c {
		if a := r.Attribution(); a != nil {
			return a
		}
	}
	return nil
}

func (c Chain) Close() error {
	var first error
	for _, r := range c {
		if err := r.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}
