# Sideways frontier pass

This pass makes profile creation the entrance to Sideways and gives an empty feed a one-tap running start.

## Product surface

- Profile setup asks only for name, handle, an optional line, and a color.
- The empty feed offers **WRITE** or **START ME OFF**.
- The visible feed modes are **FEED**, **FULL**, and **DESKTOP**.
- Post actions use ordinary language: **Like**, **Reply**, **Remix**, **Save**, and **Share**.
- The visual system is warm, physical, and window-like rather than glossy or glassy.

## Backend

Netlify Functions expose `/api/profile` and `/api/starter`. Profile and handle records use Netlify Blobs. A locally generated device secret is hashed before it becomes a backend profile identifier; the raw secret is not persisted by the function.

The starter endpoint returns a small curated feed personalized from the saved profile. It is not a replacement for the explicit Library importer, which remains available for real archive files.

## Proof

`studio/manual/tests/frontier-onboarding-clickthrough.mjs` runs at an iPhone viewport. It creates a profile, invokes the starter endpoint, inserts nine temporary proof posts, exercises the new actions and layout, deletes every proof post, then taps the empty-state starter button and repeats the insert/delete cycle. It asserts zero file choosers and zero temporary posts remaining.

The new backend is operational only after this repository is deployed through a Netlify site with Functions and Blobs enabled. A static ZIP or Netlify Drop upload cannot execute the functions.
