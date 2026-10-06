import grandpaLogo from '../assets/grandpa.jpeg';

export default function Grandpa({ small = false }: { small?: boolean }) {
  return <div className={small ? 'grandpa-mark small' : 'grandpa-mark'}>
    <img src={grandpaLogo} alt="Grandpa wearing glasses and reading a book" draggable={false} />
  </div>;
}
