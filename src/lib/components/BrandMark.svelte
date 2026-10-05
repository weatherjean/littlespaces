<script lang="ts">
  let { size = 36 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 64 64"
  fill="currentColor"
  aria-hidden="true"
  class="orbit-mark"
>
  <circle cx="32" cy="32" r="8" />
  <ellipse
    cx="32"
    cy="32"
    rx="28"
    ry="14"
    transform="rotate(-40 32 32)"
    fill="none"
    stroke="currentColor"
    stroke-width="4"
  />
  <!-- The halo obscures the orbit behind the moon and follows the current surface. -->
  <circle cx="51" cy="14" r="7.5" fill="var(--brand-halo, var(--bg))" />
  <circle cx="51" cy="14" r="4.5" />
</svg>
