//go:build !linux || android

package main

import (
	"fmt"
	"os"
)

type nativeRawTUN struct {
	file         *os.File
	name         string
	lanInterface string
}

func createNativeRawTUN(_, _, _ string, _ int, _ rawRoute) (*nativeRawTUN, error) {
	return nil, fmt.Errorf("native RAW TUN is supported only on Linux/OpenWrt")
}

func (t *nativeRawTUN) cleanup() {}

func (t *nativeRawTUN) destroy() {}
