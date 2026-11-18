package geo

import (
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
)

func TestParseAddr(t *testing.T) {
	cases := map[string]string{
		"203.0.113.9":            "203.0.113.9",
		" 203.0.113.9 ":          "203.0.113.9",
		"203.0.113.9:443":        "203.0.113.9",
		"::ffff:203.0.113.9":     "203.0.113.9",
		"2001:db8::1":            "2001:db8::1",
		"[2001:db8::1]:8443":     "2001:db8::1",
		"fe80::1%en0":            "fe80::1",
		"":                       "",
		"not an address":         "",
		"203.0.113.9, 192.0.2.1": "",
	}
	for in, want := range cases {
		addr, ok := ParseAddr(in)
		got := ""
		if ok {
			got = addr.String()
		}
		if got != want {
			t.Errorf("ParseAddr(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "networks.csv")
	text := "# comment\ncidr,country_code,country,province,city,lat,lon\n" +
		"192.0.2.0/24,AA,甲国,东省,一市,10.5,20.5\n" +
		"192.0.2.128/25,AA,甲国,东省,二市,11,21\n" +
		"2001:db8::/32,BB,乙国,,三市,-5,100\n"
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	table, err := OpenTable(path)
	if err != nil {
		t.Fatal(err)
	}
	if place, ok := table.Lookup(netip.MustParseAddr("192.0.2.5")); !ok || place.City != "一市" || place.Lat != 10.5 {
		t.Fatalf("192.0.2.5: %+v %v", place, ok)
	}
	// The most specific network wins.
	if place, ok := table.Lookup(netip.MustParseAddr("192.0.2.200")); !ok || place.City != "二市" {
		t.Fatalf("192.0.2.200: %+v %v", place, ok)
	}
	if place, ok := table.Lookup(netip.MustParseAddr("2001:db8::7")); !ok || place.CountryCode != "BB" || place.Province != "" {
		t.Fatalf("2001:db8::7: %+v %v", place, ok)
	}
	if _, ok := table.Lookup(netip.MustParseAddr("198.51.100.1")); ok {
		t.Fatal("an address outside every network has a place")
	}
	if table.Attribution() != nil {
		t.Fatal("a network table needs no credit")
	}
	bad := filepath.Join(t.TempDir(), "bad.csv")
	_ = os.WriteFile(bad, []byte("192.0.2.0/24,AA,甲国,东省,一市,north,20\n"), 0o600)
	if _, err := OpenTable(bad); err == nil {
		t.Fatal("a table with a latitude that is not a number was accepted")
	}
}

// writeMMDB builds a small city database with the schema that DB-IP City Lite and GeoLite2-City
// share.
func writeMMDB(t *testing.T, kind string) string {
	t.Helper()
	writer, err := mmdbwriter.New(mmdbwriter.Options{DatabaseType: kind, RecordSize: 24, IncludeReservedNetworks: true})
	if err != nil {
		t.Fatal(err)
	}
	insert := func(cidr string, record mmdbtype.Map) {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			t.Fatal(err)
		}
		if err := writer.Insert(network, record); err != nil {
			t.Fatal(err)
		}
	}
	names := func(en, zh string) mmdbtype.Map {
		m := mmdbtype.Map{"en": mmdbtype.String(en)}
		if zh != "" {
			m["zh-CN"] = mmdbtype.String(zh)
		}
		return m
	}
	insert("192.0.2.0/24", mmdbtype.Map{
		"city":         mmdbtype.Map{"names": names("First City", "")},
		"country":      mmdbtype.Map{"iso_code": mmdbtype.String("AA"), "names": names("Aland", "甲国")},
		"subdivisions": mmdbtype.Slice{mmdbtype.Map{"names": names("East", "东省")}},
		"location":     mmdbtype.Map{"latitude": mmdbtype.Float64(10.5), "longitude": mmdbtype.Float64(20.5)},
	})
	insert("2001:db8::/32", mmdbtype.Map{
		"country":  mmdbtype.Map{"iso_code": mmdbtype.String("BB"), "names": names("Bland", "")},
		"location": mmdbtype.Map{"latitude": mmdbtype.Float64(-5), "longitude": mmdbtype.Float64(100)},
	})
	path := filepath.Join(t.TempDir(), "city.mmdb")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := writer.WriteTo(file); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestMMDB(t *testing.T) {
	db, err := OpenMMDB(writeMMDB(t, "DBIP-City-Lite"), "zh-CN")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Names come in the preferred language, and in English where the database has no such name.
	place, ok := db.Lookup(netip.MustParseAddr("192.0.2.77"))
	if !ok || place.CountryCode != "AA" || place.Country != "甲国" || place.Province != "东省" || place.City != "First City" || place.Lat != 10.5 || place.Lon != 20.5 {
		t.Fatalf("192.0.2.77: %+v %v", place, ok)
	}
	place, ok = db.Lookup(netip.MustParseAddr("2001:db8::9"))
	if !ok || place.Country != "Bland" || place.Province != "" || place.City != "" {
		t.Fatalf("2001:db8::9: %+v %v", place, ok)
	}
	if _, ok := db.Lookup(netip.MustParseAddr("198.51.100.1")); ok {
		t.Fatal("an address the database does not know has a place")
	}
	if credit := db.Attribution(); credit == nil || credit.Href != "https://db-ip.com" {
		t.Fatalf("a DB-IP database must be credited: %+v", credit)
	}
	other, err := OpenMMDB(writeMMDB(t, "GeoLite2-City"), "en")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if credit := other.Attribution(); credit == nil || credit.Href != "https://www.maxmind.com" {
		t.Fatalf("a GeoLite database must be credited: %+v", credit)
	}
	if place, _ := other.Lookup(netip.MustParseAddr("192.0.2.1")); place.Country != "Aland" {
		t.Fatalf("English names: %+v", place)
	}
	chain := Chain{None{}, db}
	if place, ok := chain.Lookup(netip.MustParseAddr("192.0.2.1")); !ok || place.CountryCode != "AA" || chain.Attribution() == nil {
		t.Fatalf("chain: %+v %v", place, ok)
	}
}
