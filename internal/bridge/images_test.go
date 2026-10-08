package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

func testRaster(t *testing.T, format string) []byte {
	t.Helper()
	var output bytes.Buffer
	picture := image.NewRGBA(image.Rect(0, 0, 2, 2))
	picture.Set(0, 0, color.RGBA{R: 255, A: 255})
	var err error
	switch format {
	case "png":
		err = png.Encode(&output, picture)
	case "jpeg":
		err = jpeg.Encode(&output, picture, nil)
	case "gif":
		err = gif.Encode(&output, picture, nil)
	default:
		t.Fatal("unknown fixture format")
	}
	if err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func imageDataURL(mime string, data []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func TestImageDataURLsValidateActualRaster(t *testing.T) {
	for _, format := range []string{"png", "jpeg", "gif"} {
		data := testRaster(t, format)
		got, err := resolveImage(context.Background(), imageDataURL("image/"+format, data))
		if err != nil || got.MIME != "image/"+format || got.Data != base64.StdEncoding.EncodeToString(data) || !strings.HasPrefix(got.Name, "image.") {
			t.Fatalf("%s was not preserved: %+v %v", format, got, err)
		}
		if _, err := resolveImage(context.Background(), imageDataURL("image/"+format, data[:len(data)/2])); err == nil {
			t.Errorf("accepted truncated %s", format)
		}
	}
	// A one-pixel lossy WebP exercises the registered pure-Go decoder.
	webp := "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
	if got, err := resolveImage(context.Background(), "data:image/webp;base64,"+webp); err != nil || got.MIME != "image/webp" {
		t.Fatalf("valid WebP rejected: %v", err)
	}
	pngData := testRaster(t, "png")
	for _, invalid := range []string{
		imageDataURL("image/jpeg", pngData), imageDataURL("image/svg+xml", []byte("<svg/>")),
		imageDataURL("image/webp", []byte("RIFF0000WEBPVP8 ")), imageDataURL("image/png", []byte("not an image")),
		"data:image/png,not-base64", "data:image/png;base64,???", "data:image/png;base64,",
		"data:image/png;base64," + strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxImageBytes)+4),
	} {
		if _, err := resolveImage(context.Background(), invalid); err == nil {
			t.Errorf("accepted invalid image input of %d bytes", len(invalid))
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := resolveImage(ctx, imageDataURL("image/png", pngData)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation ignored: %v", err)
	}
}

func TestImageDimensionsAndAnimationAreBounded(t *testing.T) {
	for _, dimensions := range [][2]uint32{{16385, 1}, {8000, 8000}} {
		data := append([]byte(nil), testRaster(t, "png")...)
		binary.BigEndian.PutUint32(data[16:20], dimensions[0])
		binary.BigEndian.PutUint32(data[20:24], dimensions[1])
		binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
		if _, err := resolveImage(context.Background(), imageDataURL("image/png", data)); err == nil || !strings.Contains(err.Error(), "dimensions") {
			t.Fatalf("accepted excessive dimensions: %v", err)
		}
	}
	frame := image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.Black, color.White})
	var data bytes.Buffer
	if err := gif.EncodeAll(&data, &gif.GIF{Image: []*image.Paletted{frame, frame}, Delay: []int{1, 1}}); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveImage(context.Background(), imageDataURL("image/gif", data.Bytes())); err == nil || !strings.Contains(err.Error(), "animation") {
		t.Fatalf("accepted animated GIF: %v", err)
	}
}

func TestImagePublicIPFilter(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "172.16.2.3", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.254", "0.1.2.3", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:192.168.2.1", "fc00::1", "fe80::1", "fe80::1%en0", "ff02::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1"} {
		if publicImageIP(netip.MustParseAddr(raw)) {
			t.Errorf("accepted non-public address %s", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "::ffff:8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"} {
		if !publicImageIP(netip.MustParseAddr(raw)) {
			t.Errorf("rejected public address %s", raw)
		}
	}
}

func TestImageDialPinsCheckedDNSAndIgnoresProxies(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
	addresses := []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("1.1.1.1")}
	var lookups int
	var dials []string
	client := newImageClient(func(ctx context.Context, network, host string) ([]netip.Addr, error) {
		lookups++
		if host != "images.example" || network != "ip" {
			t.Fatalf("unexpected lookup %s %s", network, host)
		}
		return addresses, nil
	}, func(ctx context.Context, network, address string) (net.Conn, error) {
		dials = append(dials, address)
		if len(dials) == 1 {
			return nil, errors.New("first address unavailable")
		}
		return nil, nil
	})
	transport := client.Transport.(*http.Transport)
	if transport.Proxy != nil || !transport.DisableCompression || client.Timeout == 0 {
		t.Fatal("download transport is not bounded or uses environment proxies")
	}
	if _, err := transport.DialContext(context.Background(), "tcp", "images.example:443"); err != nil {
		t.Fatal(err)
	}
	if lookups != 1 || strings.Join(dials, ",") != "8.8.8.8:443,1.1.1.1:443" {
		t.Fatalf("dial did not pin validated DNS: %d %v", lookups, dials)
	}
	addresses = []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("10.0.0.1")}
	dials = nil
	if _, err := transport.DialContext(context.Background(), "tcp", "images.example:443"); err == nil || len(dials) != 0 {
		t.Fatal("mixed public/private DNS was dialed")
	}
}

type imageRoundTrip func(*http.Request) (*http.Response, error)

func (f imageRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestImageDownloadRedirectsLimitsAndCredentialIsolation(t *testing.T) {
	data := testRaster(t, "png")
	client := newImageClient(nil, nil)
	var calls int
	client.Transport = imageRoundTrip(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.Header.Get("Authorization") != "" || request.Header.Get("Jm-Token") != "" || request.Header.Get("Cookie") != "" || request.Header.Get("Referer") != "" {
			t.Fatal("image download carried credentials or referrer")
		}
		if request.URL.Path == "/start" {
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://other.example/image"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Request: request}, nil
	})
	got, err := resolveImageWithClient(context.Background(), "https://images.example/start?signature=secret", client)
	if err != nil || got.MIME != "image/png" || calls != 2 {
		t.Fatalf("valid image redirect failed: %v", err)
	}
	for _, target := range []string{"https://127.0.0.1/private", "https://[::ffff:127.0.0.1]/private", "https://100.64.0.1/private", "http://public.example/image", "https://user:password@public.example/image", "https://localhost/image"} {
		calls = 0
		client.Transport = imageRoundTrip(func(request *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{target}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
		})
		if _, err := resolveImageWithClient(context.Background(), "https://images.example/start?signature=secret", client); err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "password") {
			t.Fatalf("unsafe redirect or URL leak: %v", err)
		}
		if calls != 1 {
			t.Fatalf("followed unsafe redirect %s", target)
		}
	}
	calls = 0
	client.Transport = imageRoundTrip(func(request *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://images.example/loop"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})
	if _, err := resolveImageWithClient(context.Background(), "https://images.example/loop", client); err == nil || calls != 4 {
		t.Fatalf("redirect limit not enforced: %d %v", calls, err)
	}
	for _, length := range []int64{MaxImageBytes + 1, -1} {
		client.Transport = imageRoundTrip(func(request *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", MaxImageBytes+1))), ContentLength: length, Request: request}, nil
		})
		if _, err := resolveImageWithClient(context.Background(), "https://images.example/large", client); err == nil {
			t.Fatal("accepted oversized image")
		}
	}
}

func TestImageURLValidationPrecedesNetworkingAndErrorsAreRedacted(t *testing.T) {
	client := newImageClient(nil, nil)
	var calls int
	client.Transport = imageRoundTrip(func(request *http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New(request.URL.String())
	})
	for _, raw := range []string{"http://public.example/image", "file:///private/image", "https://127.0.0.1/image", "https://[::1]/image", "https://[::ffff:127.0.0.1]/image", "https://100.64.0.1/image", "https://user:password@public.example/image", "https://localhost./image", "https://printer.local/image"} {
		if _, err := resolveImageWithClient(context.Background(), raw, client); err == nil {
			t.Fatalf("accepted unsafe URL %s", raw)
		}
	}
	if calls != 0 {
		t.Fatal("unsafe URL reached network transport")
	}
	if _, err := resolveImageWithClient(context.Background(), "https://images.example/image?secret=DO_NOT_ECHO", client); err == nil || strings.Contains(err.Error(), "DO_NOT_ECHO") {
		t.Fatalf("download error disclosed URL: %v", err)
	}
}
