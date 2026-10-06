/** Pure CSS geometry inspired by the reference; no background photograph. */
export default function Corridor() {
  return (
    <div className="corridor" aria-hidden="true">
      <div className="corridor__ceiling" />
      <div className="corridor__wall corridor__wall--left" />
      <div className="corridor__wall corridor__wall--right" />
      <div className="corridor__floor" />
      <div className="corridor__trim corridor__trim--left" />
      <div className="corridor__trim corridor__trim--right" />
      <div className="corridor__light" />
      <div className="corridor__end" />
      {[0, 1, 2, 3].map(depth => (
        <div className={`corridor__frame corridor__frame--${depth}`} key={depth} />
      ))}
      <div className="corridor__haze" />
    </div>
  );
}
