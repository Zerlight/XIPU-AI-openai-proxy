package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	_ "golang.org/x/image/webp"
)

const MaxImageBytes = 10 << 20

type imageAttachment struct {
	Data string `json:"data"`
	MIME string `json:"mime"`
	Name string `json:"name"`
}

func resolveImage(ctx context.Context, rawURL string) (imageAttachment, error) {
	client := newImageClient(net.DefaultResolver.LookupNetIP, (&net.Dialer{Timeout: 10 * time.Second}).DialContext)
	defer client.CloseIdleConnections()
	return resolveImageWithClient(ctx, rawURL, client)
}

func resolveImageWithClient(ctx context.Context, rawURL string, client *http.Client) (imageAttachment, error) {
	if err := ctx.Err(); err != nil {
		return imageAttachment{}, err
	}
	var data []byte
	var claimed string
	if strings.HasPrefix(rawURL, "data:") {
		header, encoded, ok := strings.Cut(rawURL[5:], ",")
		if !ok || !strings.HasSuffix(header, ";base64") {
			return imageAttachment{}, errors.New("image data URL must use base64")
		}
		claimed = strings.TrimSuffix(header, ";base64")
		if !supportedImageMIME(claimed) {
			return imageAttachment{}, errors.New("image must be PNG, JPEG, GIF, or WebP")
		}
		if len(encoded) > base64.StdEncoding.EncodedLen(MaxImageBytes) {
			return imageAttachment{}, errors.New("image exceeds 10 MiB")
		}
		var err error
		data, err = base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil {
			return imageAttachment{}, errors.New("image data URL contains invalid base64")
		}
	} else {
		parsed, err := url.Parse(rawURL)
		if err != nil || validateImageURL(parsed) != nil {
			return imageAttachment{}, errors.New("image URL must be public HTTPS without credentials")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
		if err != nil {
			return imageAttachment{}, errors.New("invalid image URL")
		}
		request.Header.Set("Accept", "image/png, image/jpeg, image/gif, image/webp")
		response, err := client.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return imageAttachment{}, ctx.Err()
			}
			return imageAttachment{}, errors.New("could not fetch image from a public HTTPS address")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return imageAttachment{}, fmt.Errorf("image download returned HTTP %d", response.StatusCode)
		}
		if response.ContentLength > MaxImageBytes {
			return imageAttachment{}, errors.New("image exceeds 10 MiB")
		}
		data, err = io.ReadAll(io.LimitReader(response.Body, MaxImageBytes+1))
		if err != nil {
			return imageAttachment{}, errors.New("could not read image download")
		}
	}
	if len(data) == 0 || len(data) > MaxImageBytes {
		return imageAttachment{}, errors.New("image must contain at most 10 MiB")
	}
	if err := ctx.Err(); err != nil {
		return imageAttachment{}, err
	}
	mime, extension, err := validateImage(data)
	if err != nil {
		return imageAttachment{}, err
	}
	if claimed != "" && claimed != mime {
		return imageAttachment{}, errors.New("image data URL MIME type does not match its content")
	}
	if err := ctx.Err(); err != nil {
		return imageAttachment{}, err
	}
	return imageAttachment{Data: base64.StdEncoding.EncodeToString(data), MIME: mime, Name: "image." + extension}, nil
}

func supportedImageMIME(value string) bool {
	return value == "image/png" || value == "image/jpeg" || value == "image/gif" || value == "image/webp"
}

func validateImage(data []byte) (string, string, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", "", errors.New("image has an invalid or unsupported raster header")
	}
	mime := "image/" + format
	if !supportedImageMIME(mime) {
		return "", "", errors.New("image must be PNG, JPEG, GIF, or WebP")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 16384 || config.Height > 16384 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return "", "", errors.New("image dimensions exceed 16384 pixels per side or 40 megapixels")
	}
	if format == "gif" && !singleFrameGIF(data) {
		return "", "", errors.New("GIF must contain one complete frame; animation is unsupported")
	}
	decoded, actual, err := image.Decode(bytes.NewReader(data))
	if err != nil || actual != format || decoded.Bounds().Dx() != config.Width || decoded.Bounds().Dy() != config.Height {
		return "", "", errors.New("image contains invalid raster data")
	}
	if format == "jpeg" {
		return mime, "jpg", nil
	}
	return mime, format, nil
}

// Count GIF frames before decoding, so animation cannot multiply the pixel budget.
func singleFrameGIF(data []byte) bool {
	if len(data) < 13 {
		return false
	}
	position, frames := 13, 0
	if data[10]&0x80 != 0 {
		position += 3 << (1 + (data[10] & 7))
	}
	skipBlocks := func() bool {
		for position < len(data) {
			size := int(data[position])
			position++
			if size == 0 {
				return true
			}
			position += size
		}
		return false
	}
	for position < len(data) {
		kind := data[position]
		position++
		switch kind {
		case 0x3b:
			return frames == 1 && position == len(data)
		case 0x21:
			if position >= len(data) {
				return false
			}
			position++
			if !skipBlocks() {
				return false
			}
		case 0x2c:
			frames++
			if frames > 1 || position+9 > len(data) {
				return false
			}
			packed := data[position+8]
			position += 9
			if packed&0x80 != 0 {
				position += 3 << (1 + (packed & 7))
			}
			if position >= len(data) {
				return false
			}
			position++
			if !skipBlocks() {
				return false
			}
		default:
			return false
		}
	}
	return false
}

var blockedImageNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20"),
}

func publicImageIP(address netip.Addr) bool {
	if !address.IsValid() || address.Zone() != "" {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	// IPv6 outside the global unicast allocation includes translation and local-use space.
	if address.Is6() && !netip.MustParsePrefix("2000::/3").Contains(address) {
		return false
	}
	for _, prefix := range blockedImageNetworks {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func validateImageURL(value *url.URL) error {
	if value == nil || value.Scheme != "https" || value.Opaque != "" || value.User != nil || value.Hostname() == "" || strings.Contains(value.Hostname(), "%") {
		return errors.New("image URL must be public HTTPS without credentials")
	}
	host := strings.ToLower(strings.TrimSuffix(value.Hostname(), "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return errors.New("image URL must address a public host")
	}
	if address, err := netip.ParseAddr(host); err == nil && !publicImageIP(address) {
		return errors.New("image URL must address a public host")
	}
	return nil
}

func newImageClient(lookup func(context.Context, string, string) ([]netip.Addr, error), dial func(context.Context, string, string) (net.Conn, error)) *http.Client {
	transport := &http.Transport{
		Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second,
		MaxResponseHeaderBytes: 32 << 10,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, errors.New("invalid image destination")
			}
			addresses, err := lookup(ctx, "ip", host)
			if err != nil || len(addresses) == 0 {
				return nil, errors.New("could not resolve image host")
			}
			for _, ip := range addresses {
				if !publicImageIP(ip) {
					return nil, errors.New("image host resolves to a non-public address")
				}
			}
			// Dial the checked address itself: a second DNS lookup would permit rebinding.
			var last error
			for _, ip := range addresses {
				connection, err := dial(ctx, network, net.JoinHostPort(ip.Unmap().String(), port))
				if err == nil {
					return connection, nil
				}
				last = err
			}
			return nil, last
		},
	}
	return &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) > 3 {
			return errors.New("image redirect limit exceeded")
		}
		request.Header.Del("Referer")
		return validateImageURL(request.URL)
	}}
}
