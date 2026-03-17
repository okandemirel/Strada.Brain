import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { SecureWebSocketManager, validateCertificateChain } from "./communication.js";

const TEST_CA_CERT = Buffer.from(`-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUJaHDRvQfMLqB8qkE3bwBm4K9abIwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOU3RyYWRhIFRlc3QgQ0EwHhcNMjYwMzE3MTEzNTA1WhcN
MjcwMzE3MTEzNTA1WjAZMRcwFQYDVQQDDA5TdHJhZGEgVGVzdCBDQTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAN/jGGssk3hy4f4Q4XQ7RDmdLzdSFsX4
UbVD04Qo35gSZiDTnvPpnH17P4WrCV4ZEz6lFOROwSQdRYH/BJPm6XsuR6ayspU/
vaUuXmUcFh8FWEYShHy21HcfXl7726r7P6CheWg5HoX68ihRL+3hGppW8alxhFCh
v0hauLIL2VdW7uTmajfu662PPu4E0P8tpazeZdBKWn/P9hGl/pkdYMwlQ2GNPBiW
meqar8JNCw98JtYcwbv74nIGasl4cZjgHIr4f+vx6iZUDjKGTuysCuMUvhDUzk/h
HGnPqsGFH7rjTfI69SI29za6u6ljmuHkQVAPArnWkk3JM+GZapdLzXMCAwEAAaNT
MFEwHQYDVR0OBBYEFDDcKUMAuSZ8Vs+JywmvMm8PTaunMB8GA1UdIwQYMBaAFDDc
KUMAuSZ8Vs+JywmvMm8PTaunMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAEGjwi4vzyg7mGPtXgAApIYxKI9UlXlEbf0okW8WKPkVLNuiUXB0kEEQ
PE6Aeaewmmpm+7K4N2blOvi8mcFQInTtn21QJ+k2k8IHusEilh7RDnIhAyp4F3Jf
DyiKRM2cbt4d8r8Vw3PszzdNQ85tPyyKpV8DmWzsScxNb+X77gMuKosnd/Pk7ARB
8kyeWSkEuZXhFBEfUIqwyOSSSzGQrCQCWeetefq2mnlt7XbzQxX/VqXf7xEPsPO5
Q4oPTHz43biyRGAL6SNR0qyS88n+xD5zQhoDFY0fZOeDN3Sja5U2z5xdhwd9z79W
KSrtPHFW+1FUEFEI8ueVdFh4vU2Vf0w=
-----END CERTIFICATE-----
`);

const TEST_LEAF_CERT = Buffer.from(`-----BEGIN CERTIFICATE-----
MIIC/TCCAeWgAwIBAgIUXSN+nWRXZd9lRvZY4haQaakp2nwwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOU3RyYWRhIFRlc3QgQ0EwHhcNMjYwMzE3MTEzNTA1WhcN
MjcwMzE3MTEzNTA1WjAUMRIwEAYDVQQDDAlsZWFmLnRlc3QwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC131FVdlJJpCgrnervcj91+yNzHBqbbft5QJpj
YhruLxR6HYi5P8emCzueCZlA407iiISH4xjeXd4B/Eo3z6YPjdlyFB3ptoBV+Gjz
sSfkAq3WVc5fdvHpSwtv1OTVZNnbjOFcP2jtSj68WdB7xjo1iqmBNaUBmGValtsY
Ef70zvQfGW851R0d5L1XAPsyVU28B/VYmZUbUvBVZJ7UT1JCDqX1kOQDdkmxN3MY
TT4bPuycHiCAVTCb+qUmzNIO1hUTfXi6EnD1ButDkVoUW8Y2GBN+az2gTNPwAMTH
HXIgTvL2TbWOLxV21ytBt8ulnFMDu1SJhbKv+Vas23aKI5FDAgMBAAGjQjBAMB0G
A1UdDgQWBBSjiKzen60SGbnjEJUMGZ9qG/gIhjAfBgNVHSMEGDAWgBQw3ClDALkm
fFbPicsJrzJvD02rpzANBgkqhkiG9w0BAQsFAAOCAQEALUySAvoF0kJoKXYCEPPp
ydzX/5bfYI7NH3gk67lGniN6C9z5GPosUE4e9ENgdcn5ys3AYgUHVCwymEkNCuUf
dbx0W1fLqxyDuRCqwECQ6+eGCmBiUccT1FdMXCEh6YxvtSq7UMUQs7Jx/kbzVNYL
hJSj6Vb1H5pxCp3PvOqPIFplyw44Dl9+Xkng5Nw6ClCUnVWpD8OKU7MOC4j6Q2HB
q8ekDKq/HXGRDH8YuqHlSlwxhPxQyrTicG+l2moWb/bZs0R/G0/rsYZF6TIySOAH
JZKBitqPfBUTHce58T7qmlc8NQmexd4NsTFca4TkdQiD5Jvpi6UNpZgI3MezvhVt
eg==
-----END CERTIFICATE-----
`);

describe("SecureWebSocketManager", () => {
  it("rejects invalid non-empty auth tokens", () => {
    const manager = new SecureWebSocketManager({
      requireSecure: false,
      authTokenValidator: (token) => token === "valid-token",
    });

    const result = manager.validateConnection(
      {
        secure: true,
        headers: {},
      },
      "wrong-token",
    );

    expect(result.allowed).toBe(false);
    expect(result.error).toBe("Invalid authentication token");
  });

  it("accepts bearer auth headers when the validator approves them", () => {
    const manager = new SecureWebSocketManager({
      requireSecure: false,
      authTokenValidator: (token) => token === "valid-token",
    });

    const result = manager.validateConnection({
      secure: true,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.connectionId).toBeTruthy();
  });

  it("falls back to a configured authToken when no custom validator is configured", () => {
    const manager = new SecureWebSocketManager({
      requireSecure: false,
      authToken: "configured-token",
    });

    const result = manager.validateConnection({
      secure: true,
      headers: {
        authorization: "Bearer configured-token",
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.connectionId).toBeTruthy();
  });
});

describe("validateCertificateChain", () => {
  it("accepts a valid leaf/root chain signed by a trusted CA", () => {
    const result = validateCertificateChain([TEST_LEAF_CERT, TEST_CA_CERT], [TEST_CA_CERT]);

    expect(result.valid).toBe(true);
  });

  it("rejects chains whose issuer does not match the next certificate", () => {
    const result = validateCertificateChain([TEST_LEAF_CERT, TEST_LEAF_CERT], [TEST_CA_CERT]);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("issuer does not match");
  });

  it("rejects chains without a trusted root", () => {
    const result = validateCertificateChain([TEST_LEAF_CERT, TEST_CA_CERT], []);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("No trusted CA certificates configured");
  });
});
