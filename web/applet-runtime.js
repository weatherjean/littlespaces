import { h, render } from 'preact';
import { useState, useEffect, useRef, useMemo, useCallback, useReducer } from 'preact/hooks';
import htm from 'htm';
// Prebuilt once for the release. Applet source uses these globals without imports.
window.appletUI = Object.freeze({
  h,
  render,
  html: htm.bind(h),
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useReducer,
});
