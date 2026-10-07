use crate::store::{first, query, text, Result, Store};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
fn databases(store: &Store, space: &str) -> Result<Vec<Connection>> {
    store.space(space)?;
    let mut dbs = vec![];
    if let Ok(id) = store.applet_id(space) {
        dbs.push(store.applet(&id, false)?);
    }
    dbs.push(store.workspace()?);
    Ok(dbs)
}
pub fn list(store: &Store, space: &str) -> Result<Value> {
    let mut result = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for db in databases(store, space)? {
        for mut row in query(&db,"SELECT id,name,mime,width,height,bytes,created_at AS createdAt FROM photos WHERE owner=? ORDER BY created_at DESC LIMIT 500",&[json!(space)])?{if ids.insert(text(&row,"id").to_string()){row["url"]=json!(format!("/api/spaces/{space}/photos/{}",text(&row,"id")));result.push(row);}}
    }
    result.sort_by(|a, b| text(b, "createdAt").cmp(text(a, "createdAt")));
    Ok(json!(result))
}
pub fn read(store: &Store, space: &str, id: &str) -> Result<(Value, Vec<u8>)> {
    for db in databases(store, space)? {
        if let Ok(mut metadata) = first(
            &db,
            "SELECT id,name,mime,width,height,bytes FROM photos WHERE owner=? AND id=?",
            &[json!(space), json!(id)],
        ) {
            let data: Vec<u8> = db
                .query_row(
                    "SELECT data FROM photos WHERE owner=? AND id=?",
                    params![space, id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            metadata["url"] = json!(format!("/api/spaces/{space}/photos/{id}"));
            return Ok((metadata, data));
        }
    }
    Err("Photo not found in this app".into())
}
pub fn data_url(store: &Store, space: &str, id: &str) -> Result<Value> {
    let (mut value, bytes) = read(store, space, id)?;
    value["dataUrl"] = json!(format!(
        "data:{};base64,{}",
        text(&value, "mime"),
        STANDARD.encode(bytes)
    ));
    Ok(value)
}
pub fn import(store: &Store, space: &str, name: &str, bytes: &[u8]) -> Result<Value> {
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err("Choose a photo up to 8 MB".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "Use JPEG, PNG, or WebP")?;
    if !matches!(
        format,
        image::ImageFormat::Jpeg | image::ImageFormat::Png | image::ImageFormat::WebP
    ) {
        return Err("Use a still JPEG, PNG, or WebP image".into());
    }
    if format == image::ImageFormat::Png
        && image::codecs::png::PngDecoder::new(std::io::Cursor::new(bytes))
            .map_err(|_| "Invalid PNG")?
            .is_apng()
            .map_err(|_| "Invalid PNG")?
    {
        return Err("Choose a still image".into());
    }
    if format == image::ImageFormat::WebP
        && image::codecs::webp::WebPDecoder::new(std::io::Cursor::new(bytes))
            .map_err(|_| "Invalid WebP")?
            .has_animation()
    {
        return Err("Choose a still image".into());
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(160_000_000);
    reader.limits(limits);
    let (width, height) = reader.into_dimensions().map_err(|_| "Invalid image")?;
    if u64::from(width) * u64::from(height) > 40_000_000 {
        return Err("Photo exceeds pixel limit".into());
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(160_000_000);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| "Cannot decode photo")?;
    use image::ImageDecoder;
    let orientation = decoder
        .orientation()
        .map_err(|_| "Invalid image orientation")?;
    let mut image =
        image::DynamicImage::from_decoder(decoder).map_err(|_| "Cannot decode photo")?;
    image.apply_orientation(orientation);
    let decoded = image
        .resize(2048, 2048, image::imageops::FilterType::Triangle)
        .to_rgba8();
    let rgb = image::RgbImage::from_fn(decoded.width(), decoded.height(), |x, y| {
        let p = decoded.get_pixel(x, y);
        let a = u16::from(p[3]);
        image::Rgb([
            ((u16::from(p[0]) * a + 255 * (255 - a)) / 255) as u8,
            ((u16::from(p[1]) * a + 255 * (255 - a)) / 255) as u8,
            ((u16::from(p[2]) * a + 255 * (255 - a)) / 255) as u8,
        ])
    });
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85)
        .encode_image(&rgb)
        .map_err(|_| "Cannot process photo")?;
    if output.len() > 4_000_000 {
        return Err("Processed photo is too large".into());
    }
    let existing = list(store, space)?;
    let rows = existing.as_array().ok_or("Invalid photo list")?;
    if rows.len() >= 500
        || rows.iter().filter_map(|v| v["bytes"].as_u64()).sum::<u64>() + output.len() as u64
            > 200_000_000
    {
        return Err("Photo storage is full".into());
    }
    let id = crate::random_uuid();
    let name = name
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect::<String>();
    let db = databases(store, space)?.remove(0);
    db.execute("INSERT INTO photos(id,owner,name,mime,width,height,bytes,data) VALUES(?,?,?,'image/jpeg',?,?,?,?)",params![id,space,name,rgb.width(),rgb.height(),output.len(),output]).map_err(|e|e.to_string())?;
    let mut photo = first(
        &db,
        "SELECT id,name,mime,width,height,bytes FROM photos WHERE id=?",
        &[json!(id)],
    )?;
    photo["url"] = json!(format!("/api/spaces/{space}/photos/{id}"));
    Ok(photo)
}
